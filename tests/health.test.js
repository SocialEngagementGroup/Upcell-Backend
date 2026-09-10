process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.CLERK_SECRET_KEY = "sk_test_fake";
process.env.MONGODB_URL = "mongodb://localhost:27017/test";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));

const mongoose = require("mongoose");
const app = require("../src/app");

// Pulled off the app rather than reimplemented, so this tests the handler that
// actually answers the request.
const healthHandler = app._router.stack
  .find((layer) => layer.route && layer.route.path === "/health")
  .route.stack[0].handle;

const call = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  healthHandler({}, res);
  return res;
};

// Before this there was no way to ask whether the server was up without
// opening the site and waiting.
describe("GET /health", () => {
  const setState = (value) => {
    Object.defineProperty(mongoose.connection, "readyState", {
      value, configurable: true, writable: true,
    });
  };

  it("is mounted, and mounted before the router", () => {
    // A broken route file must not take the health check down with it — the
    // one moment it is most needed.
    const stack = app._router.stack;
    const health = stack.findIndex((l) => l.route && l.route.path === "/health");
    const router = stack.findIndex((l) => l.handle && l.handle.stack && l.handle.stack.length > 5);

    expect(health).toBeGreaterThan(-1);
    if (router > -1) expect(health).toBeLessThan(router);
  });

  it("answers 200 when the database is connected", () => {
    setState(1);
    const res = call();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: "connected" });
    expect(typeof res.body.uptime).toBe("number");
  });

  it("answers 503 when it is not", () => {
    // Not a 200 carrying the word "disconnected" that nobody reads. A monitor
    // watches the status code.
    setState(0);
    const res = call();

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ ok: false, db: "disconnected" });
  });

  it("reports the state as a word, not the driver's number", () => {
    // The person reading this at three in the morning should not have to look
    // up what 2 means.
    setState(2);
    expect(call().body.db).toBe("connecting");

    setState(3);
    expect(call().body.db).toBe("disconnecting");
  });

  it("says unknown rather than undefined for a state it does not know", () => {
    setState(99);
    expect(call().body.db).toBe("unknown");
  });

  it("needs no authentication", () => {
    // A monitor cannot hold a Clerk token, and there is nothing here worth
    // hiding: an uptime number and whether Mongo is reachable.
    const layer = app._router.stack.find((l) => l.route && l.route.path === "/health");

    expect(layer.route.stack).toHaveLength(1);
  });

  afterAll(() => setState(0));
});
