// Env vars must be set before the controller module is required — several
// module-level consts (endpoint_url, clientID, paypalWebhookId, the Resend
// client) read process.env at load time.
process.env.ENVIRONMENT = "TEST";
process.env.TEST_PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
process.env.TEST_PAYPAL_CLIENT_ID = "test-client-id";
process.env.TEST_PAYPAL_SECRET = "test-secret";
process.env.TEST_PAYPAL_WEBHOOK_ID = "test-webhook-id";
process.env.RESEND_KEY = "test-resend-key";
process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";
process.env.EMAIL_FROM = "noreply@example.com";

const mockSend = jest.fn().mockResolvedValue({});
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const mockAxios = jest.fn();
jest.mock("axios", () => ({ default: mockAxios, __esModule: true }));

jest.mock("../src/models/order.model");
jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/models/singleVariation.model");

const Order = require("../src/models/order.model");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const SingleVariation = require("../src/models/singleVariation.model");
const checkout = require("../src/controllers/checkout.controller");

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// generatePaypalAccessToken caches its result across calls within the
// module's lifetime (that's the whole point of the fix — see
// checkout.controller.js), which means a strict "1st call = token, 2nd
// call = verify" mock sequence breaks the moment a later test reuses the
// cached token and skips the token call. Routing by URL instead of call
// order avoids depending on that internal caching behavior.
let verifySignatureResult = { verification_status: "SUCCESS" };

beforeEach(() => {
  jest.clearAllMocks();
  PaymentEventLog.create.mockResolvedValue({});
  verifySignatureResult = { verification_status: "SUCCESS" };
  mockAxios.mockImplementation((config) => {
    if (config.url.includes("/oauth2/token")) {
      return Promise.resolve({ data: { access_token: "tok", expires_in: 3600 } });
    }
    if (config.url.includes("/verify-webhook-signature")) {
      return Promise.resolve({ data: verifySignatureResult });
    }
    return Promise.resolve({ data: {} });
  });
});

describe("updateOrderPaid — the atomic race-condition fix", () => {
  it("marks an unpaid order paid and sends exactly one admin email (no customer email on the order)", async () => {
    const updated = { _id: "order1", paypalId: "PP123", paid: true, status: "Processing" };
    Order.findOneAndUpdate.mockResolvedValue(updated);

    const result = await checkout.updateOrderPaid("PP123");

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      { paypalId: "PP123", paid: false },
      { paid: true, status: "Processing" },
      { new: true }
    );
    expect(result).toBe(updated);
    // No `email` field on this mock order — sendPaymentReceiptEmail's own
    // guard should skip silently rather than send a broken receipt.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("also sends a customer payment receipt when the order has an email and line items", async () => {
    const updated = {
      _id: "order1",
      paypalId: "PP123",
      paid: true,
      status: "Processing",
      email: "buyer@example.com",
      paidWith: "Paypal",
      line_items: [
        {
          quantity: 1,
          price_data: { product_data: { name: "iPhone 15", metadata: { quantity: 1, totalPaid: 999 } } },
        },
      ],
    };
    Order.findOneAndUpdate.mockResolvedValue(updated);

    await checkout.updateOrderPaid("PP123");
    await flushMicrotasks(); // sendPaymentReceiptEmail is fire-and-forget

    expect(mockSend).toHaveBeenCalledTimes(2);
    const receiptCall = mockSend.mock.calls.find((call) => call[0].to[0] === "buyer@example.com");
    expect(receiptCall).toBeDefined();
    expect(receiptCall[0].subject).toMatch(/payment received/i);
    expect(receiptCall[0].html).toContain("iPhone 15");
    expect(receiptCall[0].html).toContain("999.00");
  });

  it("does NOT send a second email when the order was already claimed by another caller (simulates the webhook + synchronous capture race)", async () => {
    // findOneAndUpdate's filter (paid:false) is what makes this atomic in
    // real Mongo — here we simulate the "lost the race" outcome directly:
    // a second concurrent caller gets null back.
    Order.findOneAndUpdate.mockResolvedValue(null);
    Order.findOne.mockResolvedValue({ _id: "order1", paypalId: "PP123", paid: true, status: "Processing" });

    const result = await checkout.updateOrderPaid("PP123");

    expect(result.paid).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns null without emailing when no order matches (e.g. simulator/garbage event)", async () => {
    Order.findOneAndUpdate.mockResolvedValue(null);
    Order.findOne.mockResolvedValue(null);

    const result = await checkout.updateOrderPaid("does-not-exist");

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("hasPendingCheckout — multi-tab duplicate-checkout guard", () => {
  it("returns true when a recent unpaid Stripe/PayPal order exists for the email", async () => {
    Order.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: "existing" }) });

    const result = await checkout.hasPendingCheckout("buyer@example.com");

    expect(result).toBe(true);
    const query = Order.findOne.mock.calls[0][0];
    expect(query.email).toBe("buyer@example.com");
    expect(query.paid).toBe(false);
    expect(query.paidWith).toEqual({ $in: ["Stripe", "Paypal"] });
  });

  it("returns false when no pending order exists", async () => {
    Order.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await checkout.hasPendingCheckout("buyer@example.com");

    expect(result).toBe(false);
  });
});

describe("paypalWebhook — signature verification and event handling", () => {
  const makeReqRes = (body, headers = {}) => {
    const req = { body, headers: { "paypal-transmission-id": "t1", ...headers } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn(), send: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  };

  it("rejects with 400 when PayPal's signature verification says FAILURE — no order gets touched", async () => {
    verifySignatureResult = { verification_status: "FAILURE" };

    const { req, res, next } = makeReqRes({ event_type: "PAYMENT.CAPTURE.COMPLETED" });
    await checkout.paypalWebhook(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("marks the order paid on a verified PAYMENT.CAPTURE.COMPLETED event", async () => {
    Order.findOneAndUpdate.mockResolvedValue({ _id: "order1", paypalId: "PP123", paid: true, status: "Processing" });

    const { req, res, next } = makeReqRes({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { supplementary_data: { related_ids: { order_id: "PP123" } } },
    });
    await checkout.paypalWebhook(req, res, next);

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      { paypalId: "PP123", paid: false },
      { paid: true, status: "Processing" },
      { new: true }
    );
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("marks the order Refunded on a verified PAYMENT.CAPTURE.REFUNDED event", async () => {
    Order.findOneAndUpdate.mockResolvedValue({ _id: "order1", paypalId: "PP123", status: "Refunded" });

    const { req, res, next } = makeReqRes({
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { supplementary_data: { related_ids: { order_id: "PP123" } } },
    });
    await checkout.paypalWebhook(req, res, next);

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      { paypalId: "PP123" },
      { status: "Refunded" },
      { new: true }
    );
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("routes processing errors through next(error) so the admin-alert middleware fires, instead of responding directly", async () => {
    const dbError = new Error("Mongo is down");
    Order.findOneAndUpdate.mockRejectedValue(dbError);

    const { req, res, next } = makeReqRes({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { supplementary_data: { related_ids: { order_id: "PP123" } } },
    });
    await checkout.paypalWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });

  it("handles a REFUNDED event for an order id that doesn't match anything, without crashing or erroring", async () => {
    Order.findOneAndUpdate.mockResolvedValue(null); // no matching order

    const { req, res, next } = makeReqRes({
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { supplementary_data: { related_ids: { order_id: "PP-DOES-NOT-EXIST" } } },
    });
    await checkout.paypalWebhook(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("does nothing (no crash) for an event type this app doesn't handle", async () => {
    const { req, res, next } = makeReqRes({
      event_type: "PAYMENT.AUTHORIZATION.VOIDED",
      resource: {},
    });
    await checkout.paypalWebhook(req, res, next);

    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("redelivering the same COMPLETED event twice only sends one admin/receipt email pair (idempotent at the webhook layer too)", async () => {
    // First delivery: genuinely claims the order.
    Order.findOneAndUpdate.mockResolvedValueOnce({
      _id: "order1",
      paypalId: "PP123",
      paid: true,
      status: "Processing",
    });
    // Second (redelivered) call: atomic guard means findOneAndUpdate finds
    // nothing left to claim.
    Order.findOneAndUpdate.mockResolvedValueOnce(null);
    Order.findOne.mockResolvedValue({ _id: "order1", paypalId: "PP123", paid: true });

    const event = {
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { supplementary_data: { related_ids: { order_id: "PP123" } } },
    };

    const first = makeReqRes(event);
    await checkout.paypalWebhook(first.req, first.res, first.next);
    const second = makeReqRes(event);
    await checkout.paypalWebhook(second.req, second.res, second.next);

    expect(mockSend).toHaveBeenCalledTimes(1); // admin email only sent once, not twice
  });
});

describe("capturePayment — ORDER_ALREADY_CAPTURED self-healing", () => {
  const makeReqRes = (body) => {
    const req = { body };
    const res = { json: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  };

  it("treats a retried capture that PayPal reports as already-captured as success, not an error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
        }),
    });
    Order.findOneAndUpdate.mockResolvedValue({ _id: "order1", paypalId: "PP123", paid: true });

    const { req, res, next } = makeReqRes({ orderID: "PP123" });
    await checkout.capturePayment(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ status: "COMPLETED", orderId: "order1" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("createPaypalOrder — happy path and idempotency key", () => {
  beforeEach(() => {
    mockAxios.mockImplementation((config) => {
      if (config.url.includes("/oauth2/token")) {
        return Promise.resolve({ data: { access_token: "tok", expires_in: 3600 } });
      }
      return Promise.resolve({ data: {} });
    });
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ id: "PP-NEW-ORDER", status: "CREATED" }),
    });
  });

  it("sends the total price and uses the client-provided idempotency key as PayPal-Request-Id", async () => {
    const result = await checkout.createPaypalOrder(999, "client-key-123");

    expect(result).toEqual({ id: "PP-NEW-ORDER", status: "CREATED" });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("/v2/checkout/orders");
    expect(options.headers["PayPal-Request-Id"]).toBe("client-key-123");
    const body = JSON.parse(options.body);
    expect(body.purchase_units[0].amount.value).toBe("999");
    expect(body.intent).toBe("CAPTURE");
  });

  it("falls back to a generated id when no idempotency key is supplied", async () => {
    await checkout.createPaypalOrder(500);

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers["PayPal-Request-Id"]).toEqual(expect.any(String));
    expect(options.headers["PayPal-Request-Id"].length).toBeGreaterThan(0);
  });
});

describe("makeOrderObjAndTotal — server-side pricing (the core anti-tampering property)", () => {
  const dbProduct = {
    _id: "prod1",
    price: 999, // the real, database price
    productName: "iPhone 15",
    color: { name: "Black" },
    condition: "Mint",
    storage: "128GB",
    image: "/staticImages/iphone.png",
  };

  it("computes the price from the database, ignoring anything price-like the client sent", async () => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = {
      body: {
        name: "Jane Doe",
        email: "jane@example.com",
        orders: ["prod1"],
        shipping: "standard",
        // A malicious/buggy client sending its own price — must be ignored.
        totalPrice: 1,
        price: 1,
      },
    };

    const { order, totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "Stripe" });

    expect(totalPrice).toBe(999); // from dbProduct.price, not req.body
    expect(order.line_items[0].price_data.unit_amount).toBe(99900); // cents
    expect(order.paid).toBe(false);
    expect(order.status).toBe("payment failed");
  });

  it("aggregates quantity when the same product id appears more than once in orders[]", async () => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = { body: { orders: ["prod1", "prod1", "prod1"], shipping: "standard" } };

    const { order, totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "Paypal" });

    expect(order.line_items[0].quantity).toBe(3);
    expect(totalPrice).toBe(999 * 3);
  });

  it.each([
    ["standard", 0],
    ["priority", 10.5],
    ["express", 25.0],
  ])("adds the correct shipping cost for '%s' shipping", async (shipping, expectedShippingCost) => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = { body: { orders: ["prod1"], shipping } };

    const { totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "Stripe" });

    expect(totalPrice).toBe(999 + expectedShippingCost);
  });
});
