process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

// Prefixed `mock` because jest.mock is hoisted above this line and only
// permits out-of-scope names that start with it.
const mockSendMail = jest.fn().mockResolvedValue({});
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSendMail } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/auditLog.model", () => ({ create: jest.fn() }));
jest.mock("../src/models/notification.model", () => ({ Notification: { create: jest.fn() } }));

// The real model is a Mongoose model; the controller only uses findById,
// findOne and create on it, so an explicit factory keeps the transition tables
// (exported from the same module) intact while the calls stay mockable.
jest.mock("../src/models/refundRequest.model", () => {
  const actual = jest.requireActual("../src/models/refundRequest.model");
  const mock = { findById: jest.fn(), findOne: jest.fn(), create: jest.fn(), find: jest.fn() };
  mock.ALLOWED_TRANSITIONS = actual.ALLOWED_TRANSITIONS;
  mock.ACTIVE_STATUSES = actual.ACTIVE_STATUSES;
  mock.REFUND_REQUEST_STATUSES = actual.REFUND_REQUEST_STATUSES;
  return mock;
});

const Order = require("../src/models/order.model");
const AuditLog = require("../src/models/auditLog.model");
const { Notification } = require("../src/models/notification.model");
const RefundRequest = require("../src/models/refundRequest.model");
const controller = require("../src/controllers/refundRequest.controller");

const makeReqRes = (body = {}, { params = {}, query = {}, user } = {}) => {
  const req = { body, params, query, user };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const CUSTOMER = { id: "user_1", email: "buyer@example.com", role: "customer" };
const STAFF = { id: "user_admin", email: "yasir@upcellit.com", role: "admin" };

const deviceLine = (productId, name, totalPaid) => ({
  quantity: 1,
  price_data: { product_data: { name, images: ["img.jpg"], metadata: { productId, quantity: 1, totalPaid } } },
});

const paidOrder = (overrides = {}) => ({
  _id: "order1",
  userId: "user_1",
  email: "buyer@example.com",
  paid: true,
  status: "Delivered",
  deliveredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  line_items: [deviceLine("p1", "iPhone 15", 999), deviceLine("p2", "iPad Air", 599)],
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

const requestDoc = (overrides = {}) => ({
  _id: "req1",
  orderId: "order1",
  userId: "user_1",
  email: "buyer@example.com",
  itemIds: ["p1"],
  // The reason decides whether the 15% restocking fee applies. These tests
  // assert 849.15 — 999 minus the fee — so they are change-of-mind returns.
  reasonCode: "CHANGED_MIND",
  status: "Submitted",
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

// findOne(...).lean() — the shape the controller actually calls.
const findOneResolves = (doc) => RefundRequest.findOne.mockReturnValue({ lean: async () => doc });

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
  Notification.create.mockResolvedValue({});
  mockSendMail.mockResolvedValue({});
  // The controller chains .lean() onto findOne, so the mock has to hand back a
  // query-shaped object rather than the document itself.
  findOneResolves(null);
});

describe("getRefundableItems — what the customer sees before the form", () => {
  it("lists only returnable items, with the fee stated", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({}, { params: { id: "a".repeat(24) }, user: CUSTOMER });
    await controller.getRefundableItems(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.feeNotice).toContain("15%");
  });

  // Authentication alone is not enough: changing the id in the URL must not
  // open someone else's order.
  it("refuses an order belonging to someone else", async () => {
    Order.findById.mockResolvedValue(paidOrder({ userId: "user_2", email: "other@example.com" }));

    const { req, res, next } = makeReqRes({}, { params: { id: "a".repeat(24) }, user: CUSTOMER });
    await controller.getRefundableItems(req, res, next);

    expect(res.statusCode).toBe(403);
  });

  // 200 with ok:false on purpose — the page needs to render the reason, and a
  // 4xx would send the frontend down its generic error path instead.
  it("explains an expired window rather than erroring", async () => {
    Order.findById.mockResolvedValue(
      paidOrder({ deliveredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
    );

    const { req, res, next } = makeReqRes({}, { params: { id: "a".repeat(24) }, user: CUSTOMER });
    await controller.getRefundableItems(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, reason: "window_closed" });
  });

  it("says when a request is already open", async () => {
    Order.findById.mockResolvedValue(paidOrder());
    findOneResolves({ _id: "req1", status: "ReturnApproved" });

    const { req, res, next } = makeReqRes({}, { params: { id: "a".repeat(24) }, user: CUSTOMER });
    await controller.getRefundableItems(req, res, next);

    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, reason: "request_open" });
  });
});

describe("createRefundRequest", () => {
  it("creates the request, notifies staff and emails the customer", async () => {
    Order.findById.mockResolvedValue(paidOrder());
    RefundRequest.create.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["p1"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(201);
    expect(Notification.create).toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].to).toEqual(["buyer@example.com"]);
  });

  it("refuses an order belonging to someone else", async () => {
    Order.findById.mockResolvedValue(paidOrder({ userId: "user_2", email: "other@example.com" }));

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["p1"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(RefundRequest.create).not.toHaveBeenCalled();
  });

  // An id from another order would otherwise be accepted here and refund
  // nothing later, which reads as a system fault rather than a bad request.
  it("refuses an item that is not on the order", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["not-on-this-order"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("refuses a second request while one is open", async () => {
    Order.findById.mockResolvedValue(paidOrder());
    findOneResolves({ _id: "req1", status: "Submitted" });

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["p1"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(409);
  });

  // Two clicks on a slow connection race past the findOne above; the partial
  // unique index is what actually holds, and its error has to become the same
  // sentence rather than a 500.
  it("turns a duplicate-key race into the same 409", async () => {
    Order.findById.mockResolvedValue(paidOrder());
    RefundRequest.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["p1"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses an order that was never delivered", async () => {
    Order.findById.mockResolvedValue(paidOrder({ deliveredAt: undefined }));

    const { req, res, next } = makeReqRes(
      { orderId: "order1", itemIds: ["p1"], reason: "Battery drains in two hours" },
      { user: CUSTOMER }
    );
    await controller.createRefundRequest(req, res, next);

    expect(res.statusCode).toBe(400);
  });
});

// This endpoint shipped returning 500 on every call: getAdminListPagination
// takes the whole request and reads req.query itself, and it was handed
// req.query, so it threw on req.query.query.page. Nothing covered it, so
// nothing caught it.
describe("getAdminRefundRequests — the queue", () => {
    const chain = (items) => {
        const query = {};
        query.sort = jest.fn(() => query);
        query.skip = jest.fn(() => query);
        query.limit = jest.fn(async () => items);
        return query;
    };

    it("returns the paginated queue for one status", async () => {
        RefundRequest.find.mockReturnValue(chain([requestDoc()]));
        RefundRequest.countDocuments = jest.fn().mockResolvedValue(1);

        const { req, res, next } = makeReqRes({}, { params: { status: "Submitted" }, query: {}, user: STAFF });
        await controller.getAdminRefundRequests(req, res, next);

        expect(next).not.toHaveBeenCalled();
        const body = res.json.mock.calls[0][0];
        expect(body.items).toHaveLength(1);
        expect(body.pagination.page).toBe(1);
        expect(RefundRequest.find).toHaveBeenCalledWith({ status: "Submitted" });
    });

    it("returns every status when asked for all", async () => {
        RefundRequest.find.mockReturnValue(chain([]));
        RefundRequest.countDocuments = jest.fn().mockResolvedValue(0);

        const { req, res, next } = makeReqRes({}, { params: { status: "all" }, query: {}, user: STAFF });
        await controller.getAdminRefundRequests(req, res, next);

        expect(RefundRequest.find).toHaveBeenCalledWith({});
    });
});

describe("updateRefundRequestStatus — the workflow", () => {
  // The whole point of the workflow: money cannot be committed to a device
  // nobody has looked at, so this jump must be impossible.
  it("refuses to jump from Submitted straight to Approved", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "Submitted" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({ status: "Approved" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("refuses to approve a return with no instructions to send", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "Submitted" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "ReturnApproved", returnInstructions: "   " },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("sends the instructions Yasir typed", async () => {
    const request = requestDoc({ status: "Submitted" });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "ReturnApproved", returnInstructions: "Post to 973 Harrisburg Pike" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.returnInstructions).toBe("Post to 973 Harrisburg Pike");
    expect(mockSendMail.mock.calls[0][0].html).toContain("973 Harrisburg Pike");
  });

  it("stamps who received the device and when", async () => {
    const request = requestDoc({ status: "ReturnApproved" });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({ status: "DeviceReceived" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.receivedBy).toBe("yasir@upcellit.com");
    expect(request.receivedAt).toBeInstanceOf(Date);
  });

  it("refuses a rejection with no reason, because the customer is told why", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "DeviceReceived" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({ status: "Rejected" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("emails the rejection reason to the customer", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "DeviceReceived" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "Rejected", rejectionReason: "Screen was cracked on arrival" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(mockSendMail.mock.calls[0][0].html).toContain("Screen was cracked on arrival");
  });

  it("writes the refund onto the order when approved", async () => {
    const order = paidOrder();
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "DeviceReceived" }));
    Order.findById.mockResolvedValue(order);

    const { req, res, next } = makeReqRes(
      { status: "Approved", inspectionNotes: "Good condition" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    // 999 minus the 15% restocking fee.
    expect(order.refund.amount).toBe(849.15);
    expect(order.refund.approvedBy).toBe("yasir@upcellit.com");
    expect(order.status).toBe("Refunded");
  });

  it("records the inspection on the request as well", async () => {
    const request = requestDoc({ status: "DeviceReceived" });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "Approved", inspectionNotes: "Minor scuff on the back" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.inspectionNotes).toBe("Minor scuff on the back");
    expect(request.inspectedBy).toBe("yasir@upcellit.com");
    expect(request.calculatedAmount).toBe(849.15);
  });

  it("refuses to approve an order that was already refunded", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "DeviceReceived" }));
    Order.findById.mockResolvedValue(paidOrder({ refund: { approvedAt: new Date(), amount: 100 } }));

    const { req, res, next } = makeReqRes(
      { status: "Approved", inspectionNotes: "Fine" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  // Moving to Refunded is the act of confirming the figure was typed at the
  // bank, so it stamps order.refund too rather than leaving a second box
  // somewhere else.
  it("marks the money entered at the bank when moving to Refunded", async () => {
    const order = paidOrder({
      refund: { approvedAt: new Date(), amount: 849.15, itemsTotal: 999, restockingFee: 149.85 },
    });
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "Approved" }));
    Order.findById.mockResolvedValue(order);

    const { req, res, next } = makeReqRes({ status: "Refunded" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(order.refund.enteredAtBankBy).toBe("yasir@upcellit.com");
    expect(order.refund.enteredAtBankAt).toBeInstanceOf(Date);
    // The email that did not exist before: the customer is finally told the
    // money is actually on its way.
    expect(mockSendMail.mock.calls[0][0].subject).toContain("on its way");
  });

  it("cannot move a finished request anywhere", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "Refunded" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({ status: "Approved" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("writes an audit entry naming who moved it", async () => {
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "ReturnApproved" }));
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({ status: "DeviceReceived" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_request.status_update",
        actorEmail: "yasir@upcellit.com",
      })
    );
  });

  it("404s for a request that does not exist", async () => {
    RefundRequest.findById.mockResolvedValue(null);

    const { req, res, next } = makeReqRes({ status: "DeviceReceived" }, { params: { id: "req1" }, user: STAFF });
    await controller.updateRefundRequestStatus(req, res, next);

    expect(res.statusCode).toBe(404);
  });
});
