process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/auditLog.model");
jest.mock("../src/controllers/checkout.controller", () => ({
  makeOrderObjAndTotal: jest.fn(),
}));

const Order = require("../src/models/order.model");
const AuditLog = require("../src/models/auditLog.model");
const { makeOrderObjAndTotal } = require("../src/controllers/checkout.controller");
const orderController = require("../src/controllers/order.controller");

const makeReqRes = (body = {}) => {
  const req = { body, params: {} };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn(), send: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
};

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
});

describe("createOrder — the Manual-order paid:true bug fix", () => {
  it("does NOT mark a Manual/'Contact to order' submission as paid", async () => {
    makeOrderObjAndTotal.mockResolvedValue({
      order: { paid: false, status: "payment failed", paidWith: "Manual" },
      totalPrice: 500,
    });
    Order.create.mockImplementation((doc) => Promise.resolve({ _id: "order1", ...doc }));

    const { req, res } = makeReqRes({ paidWith: "Manual" });
    await orderController.createOrder(req, res, jest.fn());

    const createdDoc = Order.create.mock.calls[0][0];
    expect(createdDoc.paid).toBe(false);
    expect(createdDoc.status).toBe("payment failed");
    expect(res.statusCode).toBe(201);
  });

  it("still marks a non-Manual order (e.g. paidWith:'Card') as paid+Processing", async () => {
    makeOrderObjAndTotal.mockResolvedValue({
      order: { paid: false, status: "payment failed", paidWith: "Card" },
      totalPrice: 500,
    });
    Order.create.mockImplementation((doc) => Promise.resolve({ _id: "order2", ...doc }));

    const { req } = makeReqRes({ paidWith: "Card" });
    await orderController.createOrder(req, makeReqRes().res, jest.fn());

    const createdDoc = Order.create.mock.calls[0][0];
    expect(createdDoc.paid).toBe(true);
    expect(createdDoc.status).toBe("Processing");
  });
});

describe("updateOrderStatus — status allowlist + not-found handling", () => {
  it("rejects a status value outside the schema's enum with 400, before touching the DB", async () => {
    const { req, res } = makeReqRes({ orderId: "order1", status: "TOTALLY_MADE_UP_STATUS" });
    await orderController.updateOrderStatus(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(Order.findById).not.toHaveBeenCalled();
  });

  it("returns 404 instead of throwing when the order doesn't exist", async () => {
    Order.findById.mockResolvedValue(null);

    const { req, res } = makeReqRes({ orderId: "does-not-exist", status: "Shipped" });
    await orderController.updateOrderStatus(req, res, jest.fn());

    expect(res.statusCode).toBe(404);
  });

  it("updates status and writes an audit log entry for a valid request", async () => {
    const mockOrder = { _id: "order1", status: "Processing", email: "buyer@example.com", save: jest.fn().mockResolvedValue(true) };
    Order.findById.mockResolvedValue(mockOrder);

    const { req, res } = makeReqRes({ orderId: "order1", status: "Shipped" });
    await orderController.updateOrderStatus(req, res, jest.fn());

    expect(mockOrder.status).toBe("Shipped");
    expect(mockOrder.save).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "order.status_update", metadata: { from: "Processing", to: "Shipped" } })
    );
  });
});
