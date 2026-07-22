process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.FRONTEND_URL = "http://localhost:5173";

const mockConstructEvent = jest.fn();
const mockSessionsCreate = jest.fn();
jest.mock("stripe", () =>
  jest.fn(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    checkout: { sessions: { create: mockSessionsCreate } },
  }))
);

jest.mock("../src/models/order.model");

// stripe.controller.js pulls these from checkout.controller.js — mocking
// the whole module isolates this test from checkout.controller's own
// internals (Resend/axios/etc.), which are covered separately in
// checkout.controller.test.js. That's what makes this an actual *unit*
// test of stripe.controller.js rather than an integration test of both.
jest.mock("../src/controllers/checkout.controller", () => ({
  makeOrderObjAndTotal: jest.fn(),
  hasPendingCheckout: jest.fn(),
  logPaymentEvent: jest.fn(),
  sendPaymentReceiptEmail: jest.fn(),
}));

const Order = require("../src/models/order.model");
const checkoutController = require("../src/controllers/checkout.controller");
const stripeController = require("../src/controllers/stripe.controller");

const makeReqRes = (overrides = {}) => {
  const req = { headers: { "stripe-signature": "sig123" }, rawBody: Buffer.from("{}"), body: {}, ...overrides };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn(), send: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("stripeWebhook — signature verification", () => {
  it("returns 400 and touches no order when the Stripe signature is invalid", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe("stripeWebhook — checkout.session.completed (atomic paid-marking)", () => {
  it("marks the order paid via an atomic findOneAndUpdate, not find-then-save", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      id: "evt_1",
      data: { object: { id: "cs_test_1", metadata: { orderId: "order1" } } },
    });
    const paidOrder = { _id: "order1", paid: true, status: "Processing" };
    Order.findOneAndUpdate.mockResolvedValue(paidOrder);

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "order1", paid: false },
      { paid: true, status: "Processing" },
      { new: true }
    );
    expect(checkoutController.sendPaymentReceiptEmail).toHaveBeenCalledWith(paidOrder);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("does not throw or error when a redelivered event finds the order already paid (findOneAndUpdate returns null)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      id: "evt_1",
      data: { object: { id: "cs_test_1", metadata: { orderId: "order1" } } },
    });
    Order.findOneAndUpdate.mockResolvedValue(null);

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("stripeWebhook — charge.refunded", () => {
  it("marks the order Refunded using the orderId carried on the charge's metadata", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      id: "evt_2",
      data: { object: { id: "ch_1", metadata: { orderId: "order1" } } },
    });
    Order.findOneAndUpdate.mockResolvedValue({ _id: "order1", status: "Refunded" });

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith({ _id: "order1" }, { status: "Refunded" });
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("does nothing if the charge has no orderId metadata (e.g. a charge from before this fix)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      id: "evt_2",
      data: { object: { id: "ch_1", metadata: {} } },
    });

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("does not crash or error when the orderId in metadata doesn't match any real order", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      id: "evt_2",
      data: { object: { id: "ch_1", metadata: { orderId: "does-not-exist" } } },
    });
    Order.findOneAndUpdate.mockResolvedValue(null);

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("stripeWebhook — unhandled event types", () => {
  it("acknowledges (200) an event type this app doesn't act on, without touching any order", async () => {
    mockConstructEvent.mockReturnValue({
      type: "payment_intent.created",
      id: "evt_3",
      data: { object: {} },
    });

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});

describe("stripeWebhook — error routing", () => {
  it("routes a processing failure through next(error) so the admin-alert middleware fires", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      id: "evt_1",
      data: { object: { id: "cs_test_1", metadata: { orderId: "order1" } } },
    });
    const dbError = new Error("Mongo is down");
    Order.findOneAndUpdate.mockRejectedValue(dbError);

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe("stripeCheckout — duplicate-checkout guard integration", () => {
  it("returns 409 without creating a Stripe session when hasPendingCheckout is true", async () => {
    checkoutController.hasPendingCheckout.mockResolvedValue(true);

    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com" } });
    await stripeController.stripeCheckout(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("stripeCheckout — happy path (session creation)", () => {
  const sampleOrder = {
    email: "buyer@example.com",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "USD",
          unit_amount: 99900,
          product_data: { name: "iPhone 15", description: "Black 128GB", images: ["/staticImages/iphone.png"] },
        },
      },
    ],
  };

  beforeEach(() => {
    checkoutController.hasPendingCheckout.mockResolvedValue(false);
    checkoutController.makeOrderObjAndTotal.mockResolvedValue({ order: sampleOrder, totalPrice: 999 });
    Order.create.mockResolvedValue({ _id: "order1", save: jest.fn().mockResolvedValue(true) });
    mockSessionsCreate.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.com/session/cs_test_1" });
  });

  it("creates the order, then a Stripe session, saves the session id, and returns the checkout URL", async () => {
    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com" } });
    await stripeController.stripeCheckout(req, res, next);

    expect(Order.create).toHaveBeenCalledWith(sampleOrder);
    expect(res.json).toHaveBeenCalledWith({ url: "https://checkout.stripe.com/session/cs_test_1" });
    expect(next).not.toHaveBeenCalled();
  });

  it("resolves relative product image paths to absolute URLs before sending to Stripe (Stripe rejects relative URLs)", async () => {
    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com" } });
    await stripeController.stripeCheckout(req, res, next);

    const [sessionPayload] = mockSessionsCreate.mock.calls[0];
    expect(sessionPayload.line_items[0].price_data.product_data.images[0]).toBe(
      "http://localhost:5173/staticImages/iphone.png"
    );
  });

  it("uses the client-generated idempotency key when the request supplies one", async () => {
    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com", idempotencyKey: "client-key-123" } });
    await stripeController.stripeCheckout(req, res, next);

    const [, options] = mockSessionsCreate.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: "client-key-123" });
  });

  it("falls back to an order-scoped idempotency key when the client doesn't supply one", async () => {
    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com" } });
    await stripeController.stripeCheckout(req, res, next);

    const [, options] = mockSessionsCreate.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: "checkout-order1" });
  });

  it("routes a Stripe API failure through next(error)", async () => {
    const stripeError = new Error("Stripe API is down");
    mockSessionsCreate.mockRejectedValue(stripeError);

    const { req, res, next } = makeReqRes({ body: { email: "buyer@example.com" } });
    await stripeController.stripeCheckout(req, res, next);

    expect(next).toHaveBeenCalledWith(stripeError);
  });
});
