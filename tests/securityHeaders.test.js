process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.FRONTEND_ORIGINS = "https://upcell.com";

// The redirect route below fires a fire-and-forget payment-log write. Without
// this mock that write buffers against a database the test never connects to,
// leaving an open handle that stops Jest exiting.
jest.mock("../src/models/paymentEventLog.model");

const http = require("http");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const app = require("../src/app");

PaymentEventLog.create.mockResolvedValue({});

let server;
let port;

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  // Block body, not a one-line arrow: the shorthand returns the server, and
  // Jest rejects a hook that both takes `done` and returns a value.
  server.close(done);
});

// Plain node:http rather than fetch — same reasoning as disabledRoutes.test.js,
// this repo's Jest/Node combination has flaky fetch inside the test environment.
// Headers are set by helmet before any route runs, so this deliberately asks
// for a path that does not exist: it exercises the middleware without waiting
// on a database this test never connects to.
const NO_DB_PATH = "/__headers_probe";

const request = (path, { method = "GET", headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false — Node keeps sockets alive by default, and a live socket
      // stops server.close() ever calling back, so the suite never exits.
      { hostname: "127.0.0.1", port, path, method, headers, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });

describe("security headers", () => {
  it("tells the browser to refuse plain HTTP for this host", async () => {
    const { headers } = await request(NO_DB_PATH);

    expect(headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(headers["strict-transport-security"]).toContain("includeSubDomains");
  });

  it("stops the browser guessing content types", async () => {
    const { headers } = await request(NO_DB_PATH);

    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses to be framed", async () => {
    const { headers } = await request(NO_DB_PATH);

    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("does not leak the path to other sites in the referrer", async () => {
    // An order id sitting in a URL must not travel to a third party.
    const { headers } = await request(NO_DB_PATH);

    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("hides which server software is running", async () => {
    const { headers } = await request(NO_DB_PATH);

    expect(headers["x-powered-by"]).toBeUndefined();
  });
});

describe("security headers must not break what already works", () => {
  it("still lets the shop, on another domain, read API responses", async () => {
    // Helmet defaults Cross-Origin-Resource-Policy to same-origin, which would
    // stop the frontend reading anything this API returns. This is the single
    // most likely way adding security headers breaks a working site.
    const { headers } = await request(NO_DB_PATH);

    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("adds no Content-Security-Policy of its own to a real response", async () => {
    // A policy on JSON governs nothing, so helmet's is switched off here; the
    // one that matters is served with the pages by Vercel (Frontend/vercel.json).
    //
    // Checked on a redirect rather than a 404, because Express's own error page
    // sets "default-src 'none'" on the HTML it generates. That is Express being
    // careful with its own output, not a policy applied to this API.
    const { headers } = await request("/boa/response", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(headers["content-security-policy"]).toBeUndefined();
  });

});
