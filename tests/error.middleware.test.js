const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/test/messages?key=k&token=t";

const makeReqRes = (overrides = {}) => {
  const req = { method: "GET", originalUrl: "/some-route", ...overrides };
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  const next = jest.fn();
  return { req, res, next };
};

// Flush the microtask queue so fetch()/resend .then()/.catch() chains (fired
// but not awaited by errorHandler itself) get a chance to run before we
// assert on their side effects.
const flush = () => new Promise((resolve) => setImmediate(resolve));

let errorHandler;
let consoleErrorSpy;

function loadMiddleware(env = {}) {
  jest.resetModules();
  process.env.RESEND_KEY = "test-resend-key";
  process.env.EMAIL_FROM = "noreply@example.com";
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";
  process.env.GOOGLE_CHAT_WEBHOOK_URL = WEBHOOK_URL;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ({ errorHandler } = require("../src/middleware/error.middleware"));
}

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({});
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  loadMiddleware();
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  delete global.fetch;
});

describe("errorHandler — client-facing response", () => {
  it("hides the real message/details behind a generic response for a 5xx", () => {
    const { req, res, next } = makeReqRes();
    errorHandler(new Error("Mongo connection string is malformed: mongodb+srv://user:pass@host"), req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", details: null });
  });

  it("defaults to 500 when err.status is unset", () => {
    const { req, res } = makeReqRes();
    errorHandler(new Error("boom"), req, res, jest.fn());
    expect(res.statusCode).toBe(500);
  });

  it("passes the real message through for a 4xx (e.g. a CORS rejection carrying status 403)", () => {
    const err = new Error("Not allowed by CORS");
    err.status = 403;
    const { req, res } = makeReqRes();
    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Not allowed by CORS", details: null });
  });

  it("passes through err.details for a 4xx when present", () => {
    const err = new Error("Validation failed");
    err.status = 400;
    err.details = { field: "email" };
    const { req, res } = makeReqRes();
    errorHandler(err, req, res, jest.fn());

    expect(res.body.details).toEqual({ field: "email" });
  });
});

describe("errorHandler — admin alert fan-out", () => {
  it("emails the admin on a 500, with no stack trace or internal error text leaked into the body", async () => {
    const err = new Error("Mongo connection string is malformed: mongodb+srv://user:pass@host");
    const { req, res } = makeReqRes();
    errorHandler(err, req, res, jest.fn());
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const emailArg = mockSend.mock.calls[0][0];
    expect(emailArg.to).toEqual(["admin@example.com"]);
    expect(emailArg.from).toBe("noreply@example.com");
    expect(emailArg.html).not.toContain("mongodb+srv");
    expect(emailArg.html).not.toContain(err.stack);
    expect(emailArg.html.toLowerCase()).not.toContain("stack");
  });

  it("posts a plain-text alert to the Google Chat webhook on a 500, with no stack trace", async () => {
    const err = new Error("Mongo connection string is malformed: mongodb+srv://user:pass@host");
    const { req, res } = makeReqRes();
    errorHandler(err, req, res, jest.fn());
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(options.method).toBe("POST");

    const payload = JSON.parse(options.body);
    expect(payload.text).not.toContain("mongodb+srv");
    expect(payload.text).not.toContain(err.stack);
  });

  it("does NOT alert email or chat for a 4xx", async () => {
    const err = new Error("Not allowed by CORS");
    err.status = 403;
    const { req, res } = makeReqRes();
    errorHandler(err, req, res, jest.fn());
    await flush();

    expect(mockSend).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throttles repeated 500s — a second error within the window sends nothing further", async () => {
    const { req, res } = makeReqRes();
    errorHandler(new Error("first"), req, res, jest.fn());
    await flush();
    errorHandler(new Error("second"), req, res, jest.fn());
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("still returns the correct client response for a throttled 500 (throttle only affects alerts)", async () => {
    const { req, res } = makeReqRes();
    errorHandler(new Error("first"), req, res, jest.fn());
    await flush();

    const { req: req2, res: res2 } = makeReqRes();
    errorHandler(new Error("second"), req2, res2, jest.fn());

    expect(res2.statusCode).toBe(500);
    expect(res2.body).toEqual({ error: "Internal Server Error", details: null });
  });

  it("sends again once the throttle window has passed", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    const { req, res } = makeReqRes();
    errorHandler(new Error("first"), req, res, jest.fn());
    await flush();

    nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    errorHandler(new Error("second"), req, res, jest.fn());
    await flush();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});

describe("errorHandler — missing config is a silent no-op per channel", () => {
  it("skips the chat alert (but still emails) when GOOGLE_CHAT_WEBHOOK_URL isn't set", async () => {
    loadMiddleware({ GOOGLE_CHAT_WEBHOOK_URL: undefined });
    const { req, res } = makeReqRes();
    errorHandler(new Error("boom"), req, res, jest.fn());
    await flush();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("skips the email alert (but still posts to chat) when ADMIN_NOTIFICATION_EMAIL isn't set", async () => {
    loadMiddleware({ ADMIN_NOTIFICATION_EMAIL: undefined });
    const { req, res } = makeReqRes();
    errorHandler(new Error("boom"), req, res, jest.fn());
    await flush();

    expect(mockSend).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("errorHandler — alert delivery failures never surface to the client", () => {
  it("logs but does not throw when Resend rejects", async () => {
    mockSend.mockRejectedValueOnce(new Error("Resend is down"));
    const { req, res } = makeReqRes();

    expect(() => errorHandler(new Error("boom"), req, res, jest.fn())).not.toThrow();
    await flush();

    expect(res.statusCode).toBe(500); // client response still went out normally
  });

  it("logs (via response.text()) but does not throw when Google Chat returns a non-OK response", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Invalid webhook token" });
    const { req, res } = makeReqRes();

    errorHandler(new Error("boom"), req, res, jest.fn());
    await flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat alert rejected (400)"),
      "Invalid webhook token"
    );
  });

  it("logs but does not throw when the Google Chat fetch itself rejects (network failure)", async () => {
    global.fetch.mockRejectedValueOnce(new Error("network unreachable"));
    const { req, res } = makeReqRes();

    expect(() => errorHandler(new Error("boom"), req, res, jest.fn())).not.toThrow();
    await flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to send Google Chat alert:", expect.any(Error));
  });
});
