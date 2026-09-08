// Boots the real app and hits the routes over HTTP, rather than calling the
// controller directly, because the thing this file exists to prove is that a
// URL is actually wired up — the controller test suite already covers what
// paymentResponse itself does with a CANCEL payload.
process.env.BOA_ACCESS_KEY = "test-access-key";
process.env.BOA_SECRET_KEY = "test-secret-key";
process.env.BOA_PROFILE_ID = "test-profile-id";
process.env.BOA_ENDPOINT = "https://testsecureacceptance.example.com/pay";
process.env.FRONTEND_URL = "https://shop.example.com";
process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.FRONTEND_ORIGINS = "https://upcell.com";

jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/services/inventory");

const http = require("http");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const inventory = require("../src/services/inventory");
const boa = require("../src/controllers/bankOfAmerica.controller");
const app = require("../src/app");

let server;
let port;

beforeEach(() => {
  jest.clearAllMocks();
  PaymentEventLog.create.mockResolvedValue({});
  inventory.releaseReservation.mockResolvedValue(0);
});

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

const post = (path, body, { origin } = {}) =>
  new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(payload),
          ...(origin ? { origin } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });

// The Custom Cancel Response Page is a separate portal setting from the
// Transaction Response Page (/boa/response) — it was left Cybersource-hosted
// until Task 2.5, so /boa/cancel never existed. This is what would have
// 404'd a real cancel notification if the route were never added.
describe("POST /boa/cancel", () => {
  it("reaches paymentResponse and releases the hold for a signed cancel", async () => {
    const body = boa.buildSignedFields({
      decision: "CANCEL",
      transaction_id: "7882749437566123004007",
      transaction_uuid: "checkout-uuid-9",
      reference_number: "6a79f7298341f33d9a65b0b7",
    });

    const res = await post("/boa/cancel", body);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://shop.example.com/cart?payment=cancelled");
    expect(inventory.releaseReservation).toHaveBeenCalledWith("checkout-uuid-9");
  });

  it("verifies the signature rather than trusting whatever the browser sends", async () => {
    const body = {
      ...boa.buildSignedFields({ decision: "CANCEL", reference_number: "6a79f7298341f33d9a65b0b7" }),
      signature: "not-real",
    };

    const res = await post("/boa/cancel", body);

    expect(res.status).toBe(302);
    expect(inventory.releaseReservation).not.toHaveBeenCalled();
  });

  it("is exempt from CORS, like the bank's other two callback URLs", async () => {
    const body = boa.buildSignedFields({ decision: "CANCEL", transaction_id: "x" });

    // A cross-site Origin the allow-list would otherwise reject. If this route
    // were not in GATEWAY_CALLBACK_PATHS, cors() would answer this preflight-less
    // simple request without Access-Control-Allow-Origin and the browser would
    // block the bank's own redirect follow-through from ever reaching the route.
    const res = await post("/boa/cancel", body, { origin: "https://ebc2test.cybersource.com" });

    expect(res.status).toBe(302);
  });
});
