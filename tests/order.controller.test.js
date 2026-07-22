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

const makeReqRes = (body = {}, { params = {}, query = {}, user } = {}) => {
  const req = { body, params, query, user };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn(), send: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
};

// Order.find(query).sort().skip().limit() — a chainable mock where sort/skip
// return the chain itself and limit resolves, matching how sendPaginatedResults
// (utils/pagination.js, used for real/unmocked here) actually calls it.
function makeQueryChain(result) {
  const chain = {};
  chain.sort = jest.fn(() => chain);
  chain.skip = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(result));
  return chain;
}

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

describe("getOrder — PII exposure guard", () => {
  const fullOrder = {
    _id: "order1",
    email: "buyer@example.com",
    name: "Jane Doe",
    phone: "1234567890",
    city: "City",
    postal: "12345",
    street: "123 Some St",
    country: "US",
    status: "Processing",
    paid: true,
  };

  it("returns the full order (including PII) to its owner", async () => {
    Order.findById.mockResolvedValue({ ...fullOrder, toObject: () => fullOrder });

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { email: "buyer@example.com" } });
    await orderController.getOrder(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ email: "buyer@example.com", name: "Jane Doe" }));
  });

  it("returns the full order to an admin regardless of email match", async () => {
    Order.findById.mockResolvedValue({ ...fullOrder, toObject: () => fullOrder });

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { role: "admin", email: "admin@upcell.com" } });
    await orderController.getOrder(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ email: "buyer@example.com" }));
  });

  it("strips name/email/phone/address for a non-owner (or anonymous) viewer", async () => {
    Order.findById.mockResolvedValue({ ...fullOrder, toObject: () => fullOrder });

    const { req, res } = makeReqRes({}, { params: { id: "order1" } }); // no req.user at all — anonymous viewer
    await orderController.getOrder(req, res, jest.fn());

    const returned = res.json.mock.calls[0][0];
    expect(returned.email).toBeUndefined();
    expect(returned.name).toBeUndefined();
    expect(returned.phone).toBeUndefined();
    expect(returned.street).toBeUndefined();
    // Non-PII fields should still come through so the order summary still renders.
    expect(returned.status).toBe("Processing");
    expect(returned.paid).toBe(true);
  });

  it("strips PII for a logged-in user who owns a different order", async () => {
    Order.findById.mockResolvedValue({ ...fullOrder, toObject: () => fullOrder });

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { email: "someone-else@example.com" } });
    await orderController.getOrder(req, res, jest.fn());

    expect(res.json.mock.calls[0][0].email).toBeUndefined();
  });

  it("returns 404 for a non-existent order", async () => {
    Order.findById.mockResolvedValue(null);

    const { req, res } = makeReqRes({}, { params: { id: "does-not-exist" } });
    await orderController.getOrder(req, res, jest.fn());

    expect(res.statusCode).toBe(404);
  });
});

describe("getAdminOrders — status/byEmail/byOrderId lookup", () => {
  it("looks up by plain status", async () => {
    Order.find.mockReturnValue(makeQueryChain([{ _id: "o1" }]));
    Order.countDocuments.mockResolvedValue(1);

    const { req, res } = makeReqRes({}, { params: { status: "Shipped" }, query: {}, user: { role: "admin" } });
    await orderController.getAdminOrders(req, res, jest.fn());

    expect(Order.find).toHaveBeenCalledWith({ status: "Shipped" });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ _id: "o1" }], pagination: expect.objectContaining({ totalItems: 1 }) })
    );
  });

  it("looks up by email when status param is 'byEmail:someone@example.com'", async () => {
    Order.find.mockReturnValue(makeQueryChain([]));
    Order.countDocuments.mockResolvedValue(0);

    const { req, res } = makeReqRes({}, { params: { status: "byEmail:buyer@example.com" }, query: {} });
    await orderController.getAdminOrders(req, res, jest.fn());

    expect(Order.find).toHaveBeenCalledWith({ email: "buyer@example.com" });
  });

  it("returns an empty result (not a DB error) for an invalid ObjectId in 'byOrderId:...'", async () => {
    const { req, res } = makeReqRes({}, { params: { status: "byOrderId:not-a-real-id" }, query: {} });
    await orderController.getAdminOrders(req, res, jest.fn());

    expect(Order.find).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ items: [] }));
  });

  it("looks up by a valid ObjectId in 'byOrderId:...'", async () => {
    const validId = "507f1f77bcf86cd799439011";
    Order.find.mockReturnValue(makeQueryChain([{ _id: validId }]));
    Order.countDocuments.mockResolvedValue(1);

    const { req, res } = makeReqRes({}, { params: { status: `byOrderId:${validId}` }, query: {} });
    await orderController.getAdminOrders(req, res, jest.fn());

    expect(Order.find).toHaveBeenCalledWith({ _id: validId });
  });
});

describe("getAdminOrdersByDate — today/this-week/this-month buckets", () => {
  it("returns three buckets from three separate queries", async () => {
    Order.find
      .mockResolvedValueOnce([{ _id: "today-order" }])
      .mockResolvedValueOnce([{ _id: "today-order" }, { _id: "week-order" }])
      .mockResolvedValueOnce([{ _id: "month-order" }]);

    const { req, res } = makeReqRes({}, { params: {}, query: {} });
    await orderController.getAdminOrdersByDate(req, res, jest.fn());

    expect(Order.find).toHaveBeenCalledTimes(3);
    expect(res.json).toHaveBeenCalledWith({
      today: [{ _id: "today-order" }],
      thisWeek: [{ _id: "today-order" }, { _id: "week-order" }],
      thisMonth: [{ _id: "month-order" }],
    });
  });

  it("routes a DB failure through next(error) instead of crashing", async () => {
    const dbError = new Error("Mongo is down");
    Order.find.mockRejectedValue(dbError);

    const { req, res, next } = makeReqRes({}, { params: {}, query: {} });
    await orderController.getAdminOrdersByDate(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe("getClientOrders — email ownership check", () => {
  it("returns 403 when a logged-in non-admin requests someone else's orders", async () => {
    const { req, res } = makeReqRes(
      {},
      { params: { email: "someone-else@example.com" }, user: { email: "buyer@example.com", role: "customer" } }
    );
    await orderController.getClientOrders(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(Order.find).not.toHaveBeenCalled();
  });

  it("returns only paid orders for the account owner", async () => {
    Order.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([{ _id: "o1", paid: true }]) });

    const { req, res } = makeReqRes(
      {},
      { params: { email: "buyer@example.com" }, user: { email: "buyer@example.com", role: "customer" } }
    );
    await orderController.getClientOrders(req, res, jest.fn());

    expect(Order.find).toHaveBeenCalledWith({ email: "buyer@example.com", paid: true });
  });

  it("allows an admin to view any customer's orders", async () => {
    Order.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    const { req, res } = makeReqRes(
      {},
      { params: { email: "buyer@example.com" }, user: { email: "admin@upcell.com", role: "admin" } }
    );
    await orderController.getClientOrders(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
  });
});
