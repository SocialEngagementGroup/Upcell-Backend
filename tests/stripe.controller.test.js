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
    Order.findOneAndUpdate.mockResolvedValue({ _id: "order1", paid: true, status: "Processing" });

    const { req, res, next } = makeReqRes();
    await stripeController.stripeWebhook(req, res, next);

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "order1", paid: false },
      { paid: true, status: "Processing" },
      { new: true }
    );
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
