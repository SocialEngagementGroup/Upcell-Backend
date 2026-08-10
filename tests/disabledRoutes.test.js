process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

const http = require("http");

// The real app — not mocked — so this exercises actual route mounting,
// not a stand-in. app.js never calls mongoose.connect() itself (that's
// server.js), so no DB is needed to listen and route requests.
const app = require("../src/app");

let server;
let port;

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

// Plain node:http request instead of global fetch — this repo's Jest/Node
// combo has flaky fetch availability inside the test environment (visible
// in error.middleware.test.js's pre-existing failures), so this stays on
// a dependency that doesn't share that instability.
function postStatus(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Stripe/PayPal routes — disabled per client decision, bank gateway replaces them", () => {
  it("returns 404 for /checkout-stripe", async () => {
    expect(await postStatus("/checkout-stripe")).toBe(404);
  });

  it("returns 404 for /stripe-webhook", async () => {
    expect(await postStatus("/stripe-webhook")).toBe(404);
  });

  it("returns 404 for /checkout-customer", async () => {
    expect(await postStatus("/checkout-customer")).toBe(404);
  });

  it("returns 404 for /checkout-customer/capture", async () => {
    expect(await postStatus("/checkout-customer/capture")).toBe(404);
  });
});
