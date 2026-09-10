process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/auditLog.model");
// An explicit factory rather than the automock: the notification model is only
// ever used here as Notification.create(...), and automocking it produced an
// undefined create.
jest.mock("../src/models/notification.model", () => ({ Notification: { create: jest.fn() } }));
jest.mock("../src/controllers/checkout.controller", () => ({
  makeOrderObjAndTotal: jest.fn(),
}));

const Order = require("../src/models/order.model");
const AuditLog = require("../src/models/auditLog.model");
const { Notification } = require("../src/models/notification.model");
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
  // Both are called fire-and-forget as `.create(...).catch(...)`, so they have
  // to hand back a promise. clearAllMocks drops the resolved value, hence
  // re-setting it here rather than once at the top.
  AuditLog.create.mockResolvedValue({});
  Notification.create.mockResolvedValue({});
});

describe("createOrder — always unpaid until the bank gateway confirms payment", () => {
  it.each(["Manual", "Card", "Stripe", "Paypal"])(
    "never marks a paidWith:'%s' order as paid, regardless of what makeOrderObjAndTotal returns",
    async (paidWith) => {
      makeOrderObjAndTotal.mockResolvedValue({
        order: { paid: false, status: "pending_payment", paidWith },
        totalPrice: 500,
      });
      Order.create.mockImplementation((doc) => Promise.resolve({ _id: "order1", ...doc }));

      const { req, res } = makeReqRes({ paidWith });
      await orderController.createOrder(req, res, jest.fn());

      const createdDoc = Order.create.mock.calls[0][0];
      expect(createdDoc.paid).toBe(false);
      expect(createdDoc.status).toBe("pending_payment");
      expect(res.statusCode).toBe(201);
    }
  );

  it("passes makeOrderObjAndTotal's order object through to Order.create untouched", async () => {
    const order = { paid: false, status: "pending_payment", paidWith: "Card" };
    makeOrderObjAndTotal.mockResolvedValue({ order, totalPrice: 500 });
    Order.create.mockImplementation((doc) => Promise.resolve({ _id: "order2", ...doc }));

    const { req, res } = makeReqRes({ paidWith: "Card" });
    await orderController.createOrder(req, res, jest.fn());

    expect(Order.create).toHaveBeenCalledWith(order);
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
    const mockOrder = { _id: "order1", status: "Processing", paid: true, email: "buyer@example.com", save: jest.fn().mockResolvedValue(true) };
    Order.findById.mockResolvedValue(mockOrder);

    const { req, res } = makeReqRes({ orderId: "order1", status: "Shipped" });
    await orderController.updateOrderStatus(req, res, jest.fn());

    expect(mockOrder.status).toBe("Shipped");
    expect(mockOrder.save).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.status_update",
        metadata: { from: "Processing", to: "Shipped", paidFrom: true, paidTo: true },
      })
    );
  });
});

// The bank gateway settles out-of-band and capturePayment's route is
// unmounted, so this endpoint is the only thing that can mark an order paid.
// If `paid` doesn't follow `status`, a confirmed order stays paid:false and
// never appears on the customer's order list (getClientOrders filters on
// paid:true) — the order is fulfilled but the customer can't see it.
describe("updateOrderStatus — keeps the paid flag in step with status", () => {
  const runStatusChange = async (from, to, { paid = false } = {}) => {
    const mockOrder = { _id: "order1", status: from, paid, email: "buyer@example.com", save: jest.fn().mockResolvedValue(true) };
    Order.findById.mockResolvedValue(mockOrder);

    const { req, res } = makeReqRes({ orderId: "order1", status: to });
    await orderController.updateOrderStatus(req, res, jest.fn());
    return { mockOrder, res };
  };

  it.each(["Processing", "Shipped", "Delivered", "Returned", "Refunded"])(
    "marks the order paid when moving to '%s'",
    async (status) => {
      const { mockOrder } = await runStatusChange("pending_payment", status);

      expect(mockOrder.paid).toBe(true);
      expect(mockOrder.status).toBe(status);
      expect(mockOrder.save).toHaveBeenCalled();
    }
  );

  it.each(["pending_payment", "payment failed"])(
    "leaves the order unpaid when moving to '%s'",
    async (status) => {
      const { mockOrder } = await runStatusChange("Processing", status, { paid: true });

      expect(mockOrder.paid).toBe(false);
      expect(mockOrder.status).toBe(status);
    }
  );

  it("confirming a pending order flips paid false -> true, making it visible to the customer", async () => {
    const { mockOrder } = await runStatusChange("pending_payment", "Processing");

    expect(mockOrder.paid).toBe(true);
  });

  it("rejecting a pending order keeps paid false", async () => {
    const { mockOrder } = await runStatusChange("pending_payment", "payment failed");

    expect(mockOrder.paid).toBe(false);
  });

  // Refunded money was received and then returned — the order stays on the
  // customer's list rather than vanishing at the moment they get refunded.
  it("keeps a refunded order paid so it does not disappear from the customer's orders", async () => {
    const { mockOrder } = await runStatusChange("Delivered", "Refunded", { paid: true });

    expect(mockOrder.paid).toBe(true);
  });

  it("records the paid transition in the audit log, not just the status change", async () => {
    await runStatusChange("pending_payment", "Processing");

    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { from: "pending_payment", to: "Processing", paidFrom: false, paidTo: true },
      })
    );
  });

  it("does not touch paid when the status is rejected by the allowlist", async () => {
    const mockOrder = { _id: "order1", status: "pending_payment", paid: false, email: "buyer@example.com", save: jest.fn() };
    Order.findById.mockResolvedValue(mockOrder);

    const { req, res } = makeReqRes({ orderId: "order1", status: "NOPE" });
    await orderController.updateOrderStatus(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(mockOrder.paid).toBe(false);
    expect(mockOrder.save).not.toHaveBeenCalled();
  });
});

describe("getOrder — who may read an order, and what of it", () => {
  const fullOrder = {
    _id: "order1",
    userId: "user_owner",
    email: "buyer@example.com",
    name: "Jane Doe",
    phone: "1234567890",
    street: "123 Some St",
    city: "City",
    state: "OH",
    postal: "12345",
    country: "US",
    status: "Processing",
    paid: true,
    items: [{ productId: "p1", name: "iPhone 15", quantity: 1, lineTotalCents: 99900, imei: "353916000000000" }],
    subtotalCents: 99900,
    shippingCents: 0,
    taxCents: 7992,
    totalCents: 107892,
    cardBrand: "visa",
    cardLast4: "4821",
    // None of the rest may ever leave.
    avsResult: "Y",
    cvnResult: "M",
    boaTransactionId: "7284419920176543904007",
    boaTransactionUuid: "0e5f...",
    signedAmount: "1078.92",
    authorizedAmount: "1078.92",
    boaDecision: "ACCEPT",
    reasonCode: "100",
    refund: { amount: 999, approvedBy: "yasir@upcellit.com", enteredAtBankBy: "yasir@upcellit.com", notes: "internal" },
  };

  // getOrder selects +guestAccessToken, so findById returns a chain here the
  // way Mongoose does rather than a bare promise.
  const findByIdReturns = (doc) =>
    Order.findById.mockReturnValue({ select: () => Promise.resolve(doc) });

  const ask = async (user, guestToken) => {
    findByIdReturns({ ...fullOrder, toObject: () => fullOrder });

    const { req, res } = makeReqRes(
      {},
      { params: { id: "6a79f7298341f33d9a65b0b7" }, user, query: guestToken ? { t: guestToken } : {} }
    );
    await orderController.getOrder(req, res, jest.fn());
    return res;
  };

  const owner = { id: "user_owner", email: "buyer@example.com", emailVerified: true };

  it("gives the owner their order, matched on the Clerk user id", async () => {
    const res = await ask(owner);

    expect(res.statusCode).toBe(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ email: "buyer@example.com", name: "Jane Doe" });
  });

  it("gives it to the owner even when their account email differs from checkout", async () => {
    // Somebody typing a different address into the checkout form used to lock
    // them out of their own order, because ownership was an email comparison.
    const res = await ask({ id: "user_owner", email: "different@example.com", emailVerified: true });

    expect(res.statusCode).toBe(200);
    expect(res.json.mock.calls[0][0]._id).toBe("order1");
  });

  it("gives it to an admin", async () => {
    const res = await ask({ id: "user_admin", role: "admin", email: "admin@upcellit.com" });

    expect(res.json.mock.calls[0][0]).toMatchObject({ email: "buyer@example.com" });
  });

  it("404s an anonymous caller who knows the id", async () => {
    // Not a stripped copy. Order ids are partly a timestamp, so one real id
    // narrows where its neighbours sit — a distinct answer would confirm
    // which of them exist.
    const res = await ask(undefined);

    expect(res.statusCode).toBe(404);
    expect(res.json.mock.calls[0][0]).toEqual({ error: "Order not found" });
  });

  it("404s a different signed-in customer", async () => {
    const res = await ask({ id: "user_someone_else", email: "someone-else@example.com", emailVerified: true });

    expect(res.statusCode).toBe(404);
  });

  it("answers a stranger exactly as it answers a missing order", async () => {
    const stranger = await ask({ id: "user_someone_else", email: "x@example.com", emailVerified: true });

    findByIdReturns(null);
    const { req, res: missing } = makeReqRes({}, { params: { id: "6a79f7298341f33d9a65b0b7" } });
    await orderController.getOrder(req, missing, jest.fn());

    expect(stranger.statusCode).toBe(missing.statusCode);
    expect(stranger.json.mock.calls[0][0]).toEqual(missing.json.mock.calls[0][0]);
  });

  it("never sends gateway, AVS or staff fields to the owner", async () => {
    // The reason this is an allowlist. A denylist leaks every field added to
    // the schema afterwards, silently.
    const res = await ask(owner);
    const body = res.json.mock.calls[0][0];

    for (const leaked of [
      "avsResult", "cvnResult", "boaTransactionId", "boaTransactionUuid",
      "signedAmount", "authorizedAmount", "boaDecision", "reasonCode", "userId",
    ]) {
      expect(body[leaked]).toBeUndefined();
    }

    expect(body.refund.approvedBy).toBeUndefined();
    expect(body.refund.enteredAtBankBy).toBeUndefined();
    expect(body.refund.notes).toBeUndefined();
    expect(body.refund.amount).toBe(999);
  });

  it("keeps what the owner actually needs", async () => {
    const body = (await ask(owner)).json.mock.calls[0][0];

    // Which card, for reconciling against a statement.
    expect(body.cardBrand).toBe("visa");
    expect(body.cardLast4).toBe("4821");
    // The IMEI of the device they bought and paid for.
    expect(body.items[0].imei).toBe("353916000000000");
    // The four figures the bank was sent.
    expect(body.totalCents).toBe(107892);
  });

  describe("orders written before userId was recorded", () => {
    const legacy = { ...fullOrder, userId: undefined };

    const askLegacy = async (user) => {
      findByIdReturns({ ...legacy, toObject: () => legacy });
      const { req, res } = makeReqRes({}, { params: { id: "6a79f7298341f33d9a65b0b7" }, user });
      await orderController.getOrder(req, res, jest.fn());
      return res;
    };

    it("falls back to a verified email match", async () => {
      const res = await askLegacy({ id: "user_x", email: "buyer@example.com", emailVerified: true });

      expect(res.statusCode).toBe(200);
    });

    it("refuses an unverified email match", async () => {
      // Otherwise claiming a stranger's order takes signing up with their
      // address and never answering the confirmation mail.
      const res = await askLegacy({ id: "user_x", email: "buyer@example.com", emailVerified: false });

      expect(res.statusCode).toBe(404);
    });

    it("ignores case and whitespace", async () => {
      const res = await askLegacy({ id: "user_x", email: "  Buyer@Example.com ", emailVerified: true });

      expect(res.statusCode).toBe(200);
    });

    it("does not fall back to email when the order has a userId", async () => {
      const res = await ask({ id: "user_x", email: "buyer@example.com", emailVerified: true });

      expect(res.statusCode).toBe(404);
    });
  });

  it("returns 404 for a non-existent order", async () => {
    Order.findById.mockReturnValue({ select: () => Promise.resolve(null) });

    const { req, res } = makeReqRes({}, { params: { id: "6a79f7298341f33d9a65b0ff" } });
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

describe("getAdminOrdersByDate — today/this-week/this-month totals", () => {
  it("returns counts and revenue for each period", async () => {
    Order.aggregate
      .mockResolvedValueOnce([{ amount: 1, money: 529 }])
      .mockResolvedValueOnce([{ amount: 3, money: 1587.5 }])
      .mockResolvedValueOnce([{ amount: 9, money: 8213.25 }]);

    const { req, res } = makeReqRes({}, { params: {}, query: {} });
    await orderController.getAdminOrdersByDate(req, res, jest.fn());

    expect(Order.aggregate).toHaveBeenCalledTimes(3);
    expect(res.json).toHaveBeenCalledWith({
      today: { amount: 1, money: 529 },
      thisWeek: { amount: 3, money: 1587.5 },
      thisMonth: { amount: 9, money: 8213.25 },
    });
  });

  it("counts only paid orders, so abandoned checkouts are not sales", async () => {
    Order.aggregate.mockResolvedValue([{ amount: 0, money: 0 }]);

    const { req, res } = makeReqRes({}, { params: {}, query: {} });
    await orderController.getAdminOrdersByDate(req, res, jest.fn());

    // The rule belongs in the query. It used to live in the dashboard's own
    // rendering code, which meant every abandoned checkout — with the
    // customer's name, email, phone and address — was sent to the browser
    // just to be discarded there.
    const [pipeline] = Order.aggregate.mock.calls[0];
    expect(pipeline[0].$match.paid).toBe(true);
  });

  it("reports zero rather than undefined when a period has no orders", async () => {
    Order.aggregate.mockResolvedValue([]);

    const { req, res } = makeReqRes({}, { params: {}, query: {} });
    await orderController.getAdminOrdersByDate(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({
      today: { amount: 0, money: 0 },
      thisWeek: { amount: 0, money: 0 },
      thisMonth: { amount: 0, money: 0 },
    });
  });

  it("routes a DB failure through next(error) instead of crashing", async () => {
    const dbError = new Error("Mongo is down");
    Order.aggregate.mockRejectedValue(dbError);

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

    expect(Order.find).toHaveBeenCalledWith({
      $or: [{ email: "buyer@example.com" }],
      paid: true,
    });
  });

  it("also matches orders placed under a different email by the same account", async () => {
    Order.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    const { req, res } = makeReqRes(
      {},
      {
        params: { email: "buyer@example.com" },
        user: { id: "user_abc", email: "buyer@example.com", role: "customer" },
      }
    );
    await orderController.getClientOrders(req, res, jest.fn());

    // The email arm keeps pre-userId orders visible; the userId arm is what
    // finds an order the customer placed while typing another address.
    expect(Order.find).toHaveBeenCalledWith({
      $or: [{ email: "buyer@example.com" }, { userId: "user_abc" }],
      paid: true,
    });
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

describe("getOrder — malformed id handling", () => {
  it("returns 404 rather than throwing when the id is not an ObjectId", async () => {
    const { req, res, next } = makeReqRes({}, { params: { id: "undefined" } });

    await orderController.getOrder(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
    // Never reaches the database — a CastError there becomes a 500 and pages
    // the admin over what is really just a bad URL.
    expect(Order.findById).not.toHaveBeenCalled();
  });
});

// This never calls the bank — UpCell has no refund API credentials, so
// Raymond or Yasir still type the amount into the Business Center by hand.
// The controller's job is the calculation, the record, and the customer email.
describe("processRefund", () => {
  const deviceLine = (productId, name, totalPaid) => ({
    quantity: 1,
    price_data: { product_data: { name, metadata: { productId, quantity: 1, totalPaid } } },
  });

  const paidOrder = (overrides = {}) => ({
    _id: "order1",
    email: "buyer@example.com",
    paid: true,
    status: "Processing",
    line_items: [deviceLine("p1", "iPhone 17", 999)],
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  it("404s for an order that does not exist", async () => {
    Order.findById.mockResolvedValue(null);

    const { req, res } = makeReqRes({}, { params: { id: "ghost" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(404);
  });

  it("refuses to refund an order that was never paid", async () => {
    Order.findById.mockResolvedValue(paidOrder({ paid: false }));

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
  });

  it("refuses a second refund on an order already refunded", async () => {
    const order = paidOrder({ refund: { approvedAt: new Date(), amount: 999 } });
    Order.findById.mockResolvedValue(order);

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(order.save).not.toHaveBeenCalled();
  });

  it("records the refund, sets status Refunded, and keeps paid true", async () => {
    const order = paidOrder();
    Order.findById.mockResolvedValue(order);

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { id: "u1", email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(order.status).toBe("Refunded");
    expect(order.paid).toBe(true);
    expect(order.refund.amount).toBe(999);
    expect(order.refund.restockingFee).toBe(0);
    expect(order.refund.approvedBy).toBe("admin@upcellit.com");
    expect(order.refund.approvedAt).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalled();
  });

  it("writes an audit log entry with the actual figures", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { id: "u1", email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.refund_processed",
        metadata: expect.objectContaining({ refundAmount: 999, itemsTotal: 999 }),
      })
    );
  });

  it("refunds only the named item on a multi-item order", async () => {
    const order = paidOrder({
      line_items: [deviceLine("p1", "iPhone 17", 999), deviceLine("p2", "Clear Case", 39)],
    });
    Order.findById.mockResolvedValue(order);

    const { req, res } = makeReqRes({ itemIds: ["p2"] }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(order.refund.itemsTotal).toBe(39);
    expect(order.refund.itemIds).toEqual(["p2"]);
  });

  it("waives the fee only with a reason recorded on the order", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res } = makeReqRes(
      { waiveRestockingFee: true, waiveReason: "Confirmed faulty screen" },
      { params: { id: "order1" }, user: { email: "admin@upcellit.com" } }
    );
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
  });

  it("400s a request that names no real item on this order", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res } = makeReqRes(
      { itemIds: ["does-not-exist"] },
      { params: { id: "order1" }, user: { email: "admin@upcellit.com" } }
    );
    await orderController.processRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
  });

  it("the response is the number a human enters at the bank, not a claim that money moved", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.message).toContain("999");
    expect(body.message.toLowerCase()).toContain("enter");
  });

  // The customer is emailed automatically; the staff were told nothing. A
  // forgotten portal entry left the customer holding an email saying they had
  // been refunded, with no money.
  it("tells the admin the refund still needs entering at the bank", async () => {
    Notification.create.mockResolvedValue({});
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order", relatedId: "order1" })
    );
    const notification = Notification.create.mock.calls[0][0];
    expect(notification.message).toContain("999");
    expect(notification.message).toContain("Business Center");
  });

  it("records the refund even when the notification cannot be written", async () => {
    Notification.create.mockRejectedValue(new Error("mongo down"));
    const order = paidOrder();
    Order.findById.mockResolvedValue(order);

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.processRefund(req, res, jest.fn());

    expect(order.save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });
});

describe("markRefundEnteredAtBank — the manual step, recorded", () => {
  const refundedOrder = (overrides = {}) => ({
    _id: "order1",
    refund: { amount: 999, approvedAt: new Date("2026-09-06T10:00:00Z") },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  it("404s for an order that does not exist", async () => {
    Order.findById.mockResolvedValue(null);

    const { req, res } = makeReqRes({}, { params: { id: "ghost" }, user: { email: "admin@upcellit.com" } });
    await orderController.markRefundEnteredAtBank(req, res, jest.fn());

    expect(res.statusCode).toBe(404);
  });

  it("refuses an order that has no recorded refund", async () => {
    Order.findById.mockResolvedValue(refundedOrder({ refund: undefined }));

    const { req, res } = makeReqRes({ reasonCode: "CHANGED_MIND" }, { params: { id: "order1" }, user: { email: "admin@upcellit.com" } });
    await orderController.markRefundEnteredAtBank(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
  });

  it("stamps who entered it and when", async () => {
    const order = refundedOrder();
    Order.findById.mockResolvedValue(order);

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { email: "yasir@upcellit.com" } });
    await orderController.markRefundEnteredAtBank(req, res, jest.fn());

    expect(order.refund.enteredAtBankBy).toBe("yasir@upcellit.com");
    expect(order.refund.enteredAtBankAt).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalled();
  });

  // Unticking would make a refund the bank already knows about look outstanding
  // again, which invites a second entry and a double refund.
  it("refuses to mark the same refund twice", async () => {
    Order.findById.mockResolvedValue(
      refundedOrder({
        refund: {
          amount: 999,
          approvedAt: new Date(),
          enteredAtBankAt: new Date(),
          enteredAtBankBy: "yasir@upcellit.com",
        },
      })
    );

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { email: "raymond@upcellit.com" } });
    await orderController.markRefundEnteredAtBank(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
  });

  it("writes an audit entry naming who did it", async () => {
    AuditLog.create.mockResolvedValue({});
    Order.findById.mockResolvedValue(refundedOrder());

    const { req, res } = makeReqRes({}, { params: { id: "order1" }, user: { email: "yasir@upcellit.com" } });
    await orderController.markRefundEnteredAtBank(req, res, jest.fn());

    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.refund_entered_at_bank",
        actorEmail: "yasir@upcellit.com",
      })
    );
  });
});

// T02 — where the parcel is. Until now an order was paid for and then went
// quiet: nothing on the record said which carrier had it or what the number
// was, so "where is my order" could only be answered by a person.
// This file's res.json is a bare jest.fn(), so the payload it was called with
// is the only place the response body exists.
const sent = (res) => res.json.mock.calls[0][0];

describe("recordOrderShipment", () => {
  const { trackingUrlFor } = orderController;

  const shippable = (overrides = {}) => ({
    _id: "order1",
    email: "buyer@example.com",
    paid: true,
    status: "Processing",
    items: [{ name: "iPhone 15 Pro" }],
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  const ship = async (order, body = {}) => {
    Order.findById.mockResolvedValue(order);
    Order.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });

    const { req, res, next } = makeReqRes(
      { carrier: "FedEx", trackingNumber: "794657312345", ...body },
      { params: { id: "6a79f7298341f33d9a65b0b7" }, user: { id: "u1", email: "yasir@upcellit.com", role: "admin" } }
    );
    await orderController.recordOrderShipment(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { res, order };
  };

  it("records the carrier and tracking number and moves the order to Shipped", async () => {
    const order = shippable();
    const { res } = await ship(order);

    // Not res.statusCode: this file's helper starts at 200, so that would
    // pass for a controller that answered nothing at all.
    expect(sent(res)).toMatchObject({ ok: true, status: "Shipped" });
    expect(order.fulfilment).toMatchObject({ carrier: "FedEx", trackingNumber: "794657312345" });
    expect(order.status).toBe("Shipped");
  });

  it("stamps shippedAt, because the return window counts from it", async () => {
    // resolveWindowStart falls back to shippedAt + 3 business days when no
    // delivery was ever recorded.
    const order = shippable();
    await ship(order);

    expect(order.shippedAt).toBeInstanceOf(Date);
  });

  it("leaves shippedAt alone when a number is corrected later", async () => {
    // Otherwise fixing a typo hands the customer a fresh return window.
    const first = new Date("2026-09-01T10:00:00Z");
    const order = shippable({ shippedAt: first, fulfilment: { trackingNumber: "OLD123456" } });

    await ship(order, { trackingNumber: "794657312345" });

    expect(order.shippedAt).toEqual(first);
  });

  it("refuses a shipment with no tracking number", async () => {
    const { res } = await ship(shippable(), { trackingNumber: "" });

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toMatch(/tracking number/i);
  });

  it("refuses a carrier it does not know", async () => {
    const { res } = await ship(shippable(), { carrier: "Pigeon" });

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toMatch(/carrier/i);
  });

  it("refuses a tracking number already on another order", async () => {
    // One parcel, one order. Otherwise a customer tracking theirs sees
    // somebody else's, and a carrier update lands on the wrong record.
    const order = shippable();
    Order.findById.mockResolvedValue(order);
    Order.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: "other-order" }) }) });

    const { req, res, next } = makeReqRes(
      { carrier: "FedEx", trackingNumber: "794657312345" },
      { params: { id: "6a79f7298341f33d9a65b0b7" }, user: { role: "admin" } }
    );
    await orderController.recordOrderShipment(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(sent(res).trackingNumberInUse).toBe("other-order");
    expect(order.save).not.toHaveBeenCalled();
  });

  it("refuses to ship an order that has not been paid for", async () => {
    const { res } = await ship(shippable({ paid: false }));

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toMatch(/paid/i);
  });

  it("emails the customer the first time, and not again on a correction", async () => {
    // "Your order is on its way" twice, for one parcel, reads as two parcels.
    const first = await ship(shippable());
    expect(sent(first.res).emailed).toBe(true);

    const again = await ship(shippable({ fulfilment: { trackingNumber: "OLD123456" } }));
    expect(sent(again.res).emailed).toBe(false);
  });

  it("records who marked it shipped, and keeps that off the customer view", async () => {
    const { order } = await ship(shippable());
    expect(order.fulfilment.shippedBy).toBe("yasir@upcellit.com");

    const { toCustomerOrder } = require("../src/utils/orderView");
    const view = toCustomerOrder({ _id: "order1", fulfilment: order.fulfilment });

    expect(view.fulfilment).toEqual({
      carrier: "FedEx",
      trackingNumber: "794657312345",
      trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=794657312345",
    });
    // The staff name and UpCell's own label document stay behind.
    expect(view.fulfilment.shippedBy).toBeUndefined();
    expect(view.fulfilment.labelUrl).toBeUndefined();
  });

  it("404s an order that is not there", async () => {
    Order.findById.mockResolvedValue(null);

    const { req, res, next } = makeReqRes(
      { carrier: "FedEx", trackingNumber: "794657312345" },
      { params: { id: "6a79f7298341f33d9a65b0b7" }, user: { role: "admin" } }
    );
    await orderController.recordOrderShipment(req, res, next);

    expect(res.statusCode).toBe(404);
  });

  describe("tracking links", () => {
    it("builds one for each carrier that has a tracking page", () => {
      expect(trackingUrlFor("FedEx", "794657312345")).toMatch(/fedex\.com.*794657312345/);
      expect(trackingUrlFor("UPS", "1Z999AA10123456784")).toMatch(/ups\.com/);
      expect(trackingUrlFor("USPS", "9400111899223197428490")).toMatch(/usps\.com/);
      expect(trackingUrlFor("DHL", "1234567890")).toMatch(/dhl\.com/);
    });

    it("gives none for Other, rather than a guess that 404s", () => {
      // A dead link is worse than the number on its own, which a customer can
      // paste anywhere.
      expect(trackingUrlFor("Other", "12345678")).toBeNull();
    });

    it("escapes the number into the URL", () => {
      expect(trackingUrlFor("FedEx", "abc def")).toContain("abc%20def");
    });
  });
});

describe("orderShippedEmail", () => {
  const { orderShippedEmail } = require("../src/services/emailTemplates");

  it("puts the tracking number in the subject and the link in the button", () => {
    const { subject, html } = orderShippedEmail({
      orderId: "order1",
      carrier: "FedEx",
      trackingNumber: "794657312345",
      trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=794657312345",
      itemNames: ["iPhone 15 Pro"],
    });

    expect(subject).toContain("794657312345");
    expect(html).toContain("https://www.fedex.com/fedextrack/?trknbr=794657312345");
    expect(html).toContain("Track Your Order");
    expect(html).toContain("iPhone 15 Pro");
  });

  it("falls back to the account page when the carrier has no tracking page", () => {
    const { html } = orderShippedEmail({
      orderId: "order1", carrier: "Other", trackingNumber: "12345678", trackingUrl: null,
    });

    expect(html).toContain("View Your Order");
  });
});
