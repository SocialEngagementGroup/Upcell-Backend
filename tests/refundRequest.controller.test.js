process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

// Prefixed `mock` because jest.mock is hoisted above this line and only
// permits out-of-scope names that start with it.
const mockSendMail = jest.fn().mockResolvedValue({});
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSendMail } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/auditLog.model", () => ({ create: jest.fn() }));
jest.mock("../src/models/notification.model", () => ({ Notification: { create: jest.fn() } }));

// The real model is a Mongoose model; the controller only uses findById,
// findOne and create on it, so an explicit factory keeps the transition tables
// (exported from the same module) intact while the calls stay mockable.
jest.mock("../src/models/refundRequest.model", () => {
  const actual = jest.requireActual("../src/models/refundRequest.model");
  const mock = {
    findById: jest.fn(), findOne: jest.fn(), create: jest.fn(), find: jest.fn(),
    // The approval queue counts each customer's prior returns in one grouped
    // query, and issuing an RMA checks which numbers are already taken.
    aggregate: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
  };
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
const { hashToken } = require("../src/utils/accessToken");

const makeReqRes = (body = {}, { params = {}, query = {}, user } = {}) => {
  const req = { body, params, query, user };
  // eslint-disable-next-line prefer-const
  let res;
  res = {
    // Deliberately not 200. A controller that throws never calls res.status,
    // and a 200 default makes that read as success — which is exactly how a
    // ReferenceError in a handler passed its own test until it was chased
    // down by hand.
    statusCode: null,
    body: undefined,
    // Express's own res.set and res.send, which the CSV export uses.
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { res.headers[name] = value; return this; },
    send: jest.fn(function capture(payload) { res.body = payload; return this; }),
    // Express sends 200 when a handler calls res.json without a status, so the
    // stub does too. A handler that throws calls neither, and statusCode stays
    // null — which is the distinction the default of 200 used to hide.
    json: jest.fn(function capture(payload) {
      if (res.statusCode === null) res.statusCode = 200;
      res.body = payload;
      return this;
    }),
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
  // A change-of-mind return. Since V3.1 the reason no longer changes what is
  // refunded — there is no restocking fee on any route — but it still decides
  // who pays the postage.
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

  // Issuing an RMA asks for the highest number already used this year, then
  // whether its own candidate is taken. Nothing taken, by default.
  // Three different chains land on findOne: the RMA lookup sorts and selects,
  // the tracking-clash check selects, and the open-request check leans
  // directly. One stub that answers all three, with nothing found.
  RefundRequest.findOne.mockReturnValue({
    sort: () => ({ select: () => ({ lean: async () => null }) }),
    select: () => ({ lean: async () => null }),
    lean: async () => null,
  });
  RefundRequest.exists.mockResolvedValue(false);
  // No prior returns for anyone, unless a test says otherwise.
  RefundRequest.aggregate.mockResolvedValue([]);
  RefundRequest.countDocuments.mockResolvedValue(0);
  // The queue reads each row's order for value and delivery date.
  Order.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

describe("getRefundableItems — what the customer sees before the form", () => {
  it("lists only returnable items, and says returns are free", async () => {
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes({}, { params: { id: "a".repeat(24) }, user: CUSTOMER });
    await controller.getRefundableItems(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(2);
    // The reversal, in the one sentence the customer actually reads.
    expect(body.feeNotice).toMatch(/free/i);
    expect(body.feeNotice).not.toMatch(/15%/);
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
    const request = requestDoc({ status: "InTransit" });
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
    expect(order.refund.amount).toBe(999);
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
    expect(request.calculatedAmount).toBe(999);
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
      refund: { approvedAt: new Date(), amount: 999, itemsTotal: 999, restockingFee: 149.85 },
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
    RefundRequest.findById.mockResolvedValue(requestDoc({ status: "InTransit" }));
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

// R.3 — the approval queue, RMA issue, and the dispute record.
describe("approving a return issues its RMA", () => {
  const approve = async (request) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "ReturnApproved", returnInstructions: "Post to 973 Harrisburg Pike" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);
    return { res, next };
  };

  it("gives the request a number and an expiry", async () => {
    const request = requestDoc({ status: "Submitted" });

    await approve(request);

    expect(request.rmaNumber).toMatch(/^RMA-\d{4}-\d{5}$/);
    expect(request.rma.expiresAt.getTime()).toBeGreaterThan(request.rma.issuedAt.getTime());
  });

  it("issues nothing before staff have agreed", async () => {
    // A number handed out at submission means a customer holds a reference for
    // a return that might then be declined.
    const request = requestDoc({ status: "Submitted" });

    expect(request.rmaNumber).toBeUndefined();
  });

  it("does not renumber a request that already has one", async () => {
    // By the time a request is re-saved, the first number is on a box in the
    // post. Changing it strands the parcel.
    const request = requestDoc({ status: "Submitted", rmaNumber: "RMA-2026-00042" });

    await approve(request);

    expect(request.rmaNumber).toBe("RMA-2026-00042");
  });
});

describe("the timeline is written on every move", () => {
  it("records who changed the status, and from what to what", async () => {
    const request = requestDoc({ status: "Submitted", timeline: [] });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "ReturnApproved", returnInstructions: "Post to 973 Harrisburg Pike" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.timeline).toHaveLength(1);
    expect(request.timeline[0]).toMatchObject({
      event: "status_changed",
      from: "Submitted",
      to: "ReturnApproved",
      actor: STAFF.email,
      actorType: "staff",
    });
  });

  it("keeps the rejection reason in the record, not just on the request", async () => {
    const request = requestDoc({ status: "Submitted", timeline: [] });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "Rejected", rejectionReason: "Outside the return window" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.timeline[0].meta.rejectionReason).toBe("Outside the return window");
  });

  it("appends rather than replacing what is already there", async () => {
    const request = requestDoc({
      status: "Submitted",
      timeline: [{ event: "requested", actorType: "customer" }],
    });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "ReturnApproved", returnInstructions: "Post to 973 Harrisburg Pike" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);

    expect(request.timeline).toHaveLength(2);
    expect(request.timeline[0].event).toBe("requested");
  });
});

describe("the approval queue carries the numbers staff read", () => {
  const queueWith = async (request, { order, priorReturns = 0 } = {}) => {
    const chain = { sort: () => chain, skip: () => chain, limit: async () => [request] };
    RefundRequest.find.mockReturnValue(chain);
    RefundRequest.countDocuments.mockResolvedValue(1);
    RefundRequest.aggregate.mockResolvedValue(
      priorReturns ? [{ _id: request.userId, count: priorReturns + 1 }] : []
    );
    Order.find.mockReturnValue({ select: () => ({ lean: async () => (order ? [order] : []) }) });

    const { req, res, next } = makeReqRes({}, { params: { status: "Submitted" }, query: {}, user: STAFF });
    await controller.getAdminRefundRequests(req, res, next);
    return res.json.mock.calls[0][0];
  };

  it("puts order value and days since delivery on the row", async () => {
    const body = await queueWith(requestDoc({ status: "Submitted" }), {
      order: {
        _id: "order1",
        totalCents: 129900,
        deliveredAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      },
    });

    expect(body.items[0].queue.orderValue).toBe(1299);
    expect(body.items[0].queue.daysSinceDelivery).toBe(4);
  });

  it("flags a high-value order so it gets a second look", async () => {
    const body = await queueWith(requestDoc({ status: "Submitted" }), {
      order: { _id: "order1", totalCents: 200000, deliveredAt: new Date() },
    });

    const flags = body.items[0].queue.flags.map((flag) => flag.code);
    expect(flags).toContain("HIGH_VALUE");
  });

  it("does not count this request as one of the customer's prior returns", async () => {
    // The aggregate counts every return including the one on screen, so a
    // first-time returner would otherwise read as having one already.
    const body = await queueWith(requestDoc({ status: "Submitted" }), {
      order: { _id: "order1", totalCents: 50000, deliveredAt: new Date() },
      priorReturns: 0,
    });

    expect(body.items[0].queue.priorReturns).toBe(0);
  });

  it("keeps the items/pagination shape every other admin list uses", async () => {
    const body = await queueWith(requestDoc({ status: "Submitted" }));

    expect(body.pagination).toMatchObject({ page: 1, totalItems: 1 });
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// R.2 — what the customer is told before they commit.
describe("the return form is told the policy for the reason it picked", () => {
  const ask = async (query = {}) => {
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      {},
      { params: { id: "a".repeat(24) }, query, user: CUSTOMER }
    );
    await controller.getRefundableItems(req, res, next);
    return res.json.mock.calls[0][0];
  };

  it("sends the whole reason list, so the form is never out of step with the rules", async () => {
    const body = await ask();

    expect(body.reasons.length).toBeGreaterThan(10);
    // MISSING_ITEMS is gone — UpCell ships devices only, nothing in the box.
    expect(body.reasons.map((entry) => entry.code)).not.toContain("MISSING_ITEMS");
    const changedMind = body.reasons.find((entry) => entry.code === "CHANGED_MIND");
    expect(changedMind).toMatchObject({
      windowDays: 30,
      customerPaysPostage: false,
      restockingFee: false,
    });
  });

  it("marks a faulty device as free to return, with the longer window", async () => {
    const body = await ask();

    expect(body.reasons.find((entry) => entry.code === "WONT_POWER_ON")).toMatchObject({
      windowDays: 30,
      customerPaysPostage: false,
      restockingFee: false,
    });
  });

  it("marks OTHER as needing a written note", async () => {
    const body = await ask();

    expect(body.reasons.find((entry) => entry.code === "OTHER").requiresNote).toBe(true);
  });

  it("gives no estimate until a reason is chosen", async () => {
    expect((await ask()).estimate).toBeNull();
  });

  it("deducts nothing on a change-of-mind return either", async () => {
    // The reversal: this used to be 15% and the customer's postage.
    const body = await ask({ reasonCode: "CHANGED_MIND" });

    expect(body.estimate.restockingFee).toBe(0);
    expect(body.estimate.customerPaysPostage).toBe(false);
  });

  it("deducts nothing when the device is faulty", async () => {
    // The number the customer is quoted has to match what they are actually
    // paid, and a faulty device is never charged the fee.
    const body = await ask({ reasonCode: "WONT_POWER_ON" });

    expect(body.estimate.restockingFee).toBe(0);
    expect(body.estimate.customerPaysPostage).toBe(false);
  });

  it("stops promising a fee that no longer applies to every return", async () => {
    const body = await ask({ reasonCode: "WONT_POWER_ON" });

    expect(body.feeNotice).toMatch(/No restocking fee/i);
  });

  it("gives every reason the same 30-day window", async () => {
    const changeOfMind = await ask({ reasonCode: "CHANGED_MIND" });
    const faulty = await ask({ reasonCode: "WONT_POWER_ON" });

    expect(changeOfMind.windowDays).toBe(30);
    expect(faulty.windowDays).toBe(30);
    // Same day, not the same millisecond — the two calls are a tick apart and
    // the window is measured from the order, not from now.
    expect(new Date(changeOfMind.closesAt).toDateString())
      .toBe(new Date(faulty.closesAt).toDateString());
  });
});

// R.4 — the label, and finding a parcel that has arrived.
describe("recordReturnLabel", () => {
  const attach = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { carrier: "FedEx", trackingNumber: "794123456789", labelUrl: "https://cdn/label.pdf", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.recordReturnLabel(req, res, next);
    return { res, next, request };
  };

  it("records the label and moves the return to LabelIssued", async () => {
    const request = requestDoc({ status: "ReturnApproved", rmaNumber: "RMA-2026-00001", timeline: [] });

    const { res } = await attach(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("LabelIssued");
    expect(request.shipping.inbound.trackingNumber).toBe("794123456789");
  });

  it("emails the customer the label, the number and the deadline", async () => {
    const request = requestDoc({
      status: "ReturnApproved",
      rmaNumber: "RMA-2026-00001",
      rma: { expiresAt: new Date("2026-09-24") },
      timeline: [],
    });

    await attach(request);

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain("RMA-2026-00001");
    expect(html).toContain("794123456789");
    expect(html).toContain("label.pdf");
  });

  it("refuses a tracking number already on another open return", async () => {
    // Two live returns sharing a number means the receiving desk scans a parcel
    // and gets two answers.
    const request = requestDoc({ status: "ReturnApproved", timeline: [] });
    RefundRequest.findOne.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: "other", rmaNumber: "RMA-2026-00099" }) }),
    });

    const { res } = await attach(request);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("RMA-2026-00099");
    expect(request.status).toBe("ReturnApproved");
  });

  it("refuses a carrier UpCell does not ship with", async () => {
    const request = requestDoc({ status: "ReturnApproved", timeline: [] });

    const { res } = await attach(request, { carrier: "Pigeon" });

    expect(res.statusCode).toBe(400);
  });

  it("lets a corrected label replace the first without failing the transition", async () => {
    // Re-uploading onto a request already in LabelIssued should swap the file,
    // not refuse because LabelIssued cannot become LabelIssued.
    const request = requestDoc({ status: "LabelIssued", rmaNumber: "RMA-2026-00001", timeline: [] });

    const { res } = await attach(request, { trackingNumber: "999888777666" });

    expect(res.statusCode).toBe(200);
    expect(request.shipping.inbound.trackingNumber).toBe("999888777666");
    expect(request.timeline.at(-1).event).toBe("label_replaced");
  });

  it("records who attached it", async () => {
    const request = requestDoc({ status: "ReturnApproved", timeline: [] });

    await attach(request);

    expect(request.timeline[0]).toMatchObject({ to: "LabelIssued", actor: STAFF.email });
  });
});

describe("lookupReturnRequest — a parcel on the bench", () => {
  const lookup = async (q) => {
    const { req, res, next } = makeReqRes({}, { query: { q }, user: STAFF });
    await controller.lookupReturnRequest(req, res, next);
    return res;
  };

  it("finds a return by its RMA", async () => {
    RefundRequest.findOne.mockReturnValue({ lean: async () => ({ _id: "req1", rmaNumber: "RMA-2026-00412" }) });

    const res = await lookup("RMA-2026-00412");

    expect(res.statusCode).toBe(200);
    expect(res.body.request.rmaNumber).toBe("RMA-2026-00412");
  });

  it("finds one by tracking number, whatever case it was typed in", async () => {
    RefundRequest.findOne.mockReturnValue({ lean: async () => ({ _id: "req1" }) });

    await lookup("abc123456");

    const query = RefundRequest.findOne.mock.calls[0][0];
    expect(query.$or[1]["shipping.inbound.trackingNumber"]).toBe("ABC123456");
  });

  it("tells staff not to create a new record when nothing matches", async () => {
    // The wrong instinct here leaves the customer's request open forever
    // alongside a duplicate with no history.
    RefundRequest.findOne.mockReturnValue({ lean: async () => null });

    const res = await lookup("RMA-2026-99999");

    expect(res.statusCode).toBe(404);
    expect(res.body.hint).toMatch(/do not create a new request/i);
  });

  it("refuses a search term too short to mean anything", async () => {
    expect((await lookup("RM")).statusCode).toBe(400);
  });
});

// R.5 — a parcel becomes a device in someone's hand.
describe("receiving a device", () => {
  const receive = async (from) => {
    const request = requestDoc({ status: from, timeline: [] });
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { status: "DeviceReceived" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);
    return { request, res };
  };

  it("can be received once the parcel is moving or has landed", async () => {
    // Something has to say the parcel is actually on its way before anyone can
    // say it arrived.
    for (const from of ["InTransit", "Delivered"]) {
      const { request, res } = await receive(from);

      expect(res.statusCode).toBe(200);
      expect(request.status).toBe("DeviceReceived");
    }
  });

  it("records who took it in, and when", async () => {
    const { request } = await receive("InTransit");

    expect(request.receivedBy).toBe(STAFF.email);
    expect(request.receivedAt).toBeInstanceOf(Date);
  });

  it("tells the customer it arrived", async () => {
    await receive("Delivered");

    expect(mockSendMail).toHaveBeenCalled();
  });

  it("will not accept a device on a return that was never approved", async () => {
    const { request, res } = await receive("Submitted");

    expect(res.statusCode).toBe(400);
    expect(request.status).toBe("Submitted");
  });
});

// R.6 — the inspection.
describe("submitInspection", () => {
  const { CHECKLIST_ITEMS } = require("../src/constants/inspectionChecklist");

  const allPass = (overrides = {}) => CHECKLIST_ITEMS.map((item) => {
    if (item.measured) return { key: item.key, value: overrides[item.key] ?? 92 };
    if (item.graded) return { key: item.key, grade: overrides[item.key] || "EXCELLENT" };
    return { key: item.key, result: overrides[item.key] || "pass" };
  });

  const fivePhotos = Array.from({ length: 5 }, (_, index) => ({
    url: `https://cdn/p${index}.jpg`,
    publicId: `upcell/returns/p${index}`,
  }));

  const inspect = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      { checklist: allPass(), photos: fivePhotos, findings: "Looks as described", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.submitInspection(req, res, next);
    return { res, request };
  };

  it("records the inspection and who did it", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    const { res } = await inspect(request);

    expect(res.statusCode).toBe(200);
    expect(request.inspection.inspectorId).toBe(STAFF.email);
    expect(request.inspection.completedAt).toBeInstanceOf(Date);
    expect(request.inspection.checklist).toHaveLength(CHECKLIST_ITEMS.length);
  });

  it("stamps every photo with a purge date, so none outlive the policy", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request);

    expect(request.inspection.photos).toHaveLength(5);
    expect(request.inspection.photos.every((photo) => photo.purgeAfter instanceof Date)).toBe(true);
  });

  it("refuses an incomplete checklist and says what is missing", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    const { res } = await inspect(request, { checklist: allPass().slice(0, 3) });

    expect(res.statusCode).toBe(400);
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(request.inspection).toBeUndefined();
  });

  it("refuses fewer than five photos", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    const { res } = await inspect(request, { photos: fivePhotos.slice(0, 4) });

    expect(res.statusCode).toBe(400);
  });

  it("will not inspect a device that has not arrived", async () => {
    // A carrier saying "delivered" is a claim about a doorstep, not about a
    // device in someone's hand.
    const request = requestDoc({ status: "Delivered", timeline: [] });

    const { res } = await inspect(request);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/received first/i);
  });

  it("sends a locked device to ActionRequired rather than rejecting it", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    const { res } = await inspect(request, { checklist: allPass({ activation_lock: "fail" }) });

    expect(request.status).toBe("ActionRequired");
    expect(res.body.suggested.outcome).toBe("ACTION_REQUIRED");
  });

  it("rejects a device whose IMEI does not match the order", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request, { checklist: allPass({ imei_matches: "fail" }) });

    expect(request.status).toBe("Rejected");
  });

  it("offers less when the device came back a grade lower than it sold at", async () => {
    const request = requestDoc({
      status: "DeviceReceived",
      device: { gradeAtSale: "EXCELLENT" },
      timeline: [],
    });

    const { res } = await inspect(request, { checklist: allPass({ cosmetic_grade: "GOOD" }) });

    expect(request.status).toBe("RevisedOffer");
    expect(res.body.grade).toBe("GOOD");
  });

  it("refunds in full when only the battery fell", async () => {
    // Sold at 92%, back at 81%, looking the same. Nothing deducted, nothing
    // re-graded — this is the rule the whole policy turns on.
    const request = requestDoc({
      status: "DeviceReceived",
      device: { gradeAtSale: "EXCELLENT" },
      timeline: [],
    });

    const { res } = await inspect(request, {
      checklist: allPass({ battery_health: 81, cosmetic_grade: "EXCELLENT" }),
    });

    expect(res.body.suggested.outcome).toBe("FULL_REFUND");
    expect(res.body.suggested.disposition.regraded).toBe(false);
  });

  it("only demands the fault check when the customer claimed a fault", async () => {
    // A change-of-mind return has no fault to reproduce.
    const request = requestDoc({
      status: "DeviceReceived", reasonCategory: "PREFERENCE", timeline: [],
    });
    const withoutFaultCheck = allPass().filter((entry) => entry.key !== "fault_reproduced");

    const { res } = await inspect(request, { checklist: withoutFaultCheck });

    expect(res.statusCode).toBe(200);
  });

  it("relists a device that came back as it left", async () => {
    const request = requestDoc({
      status: "DeviceReceived",
      device: { gradeAtSale: "EXCELLENT" },
      timeline: [],
    });

    const { res } = await inspect(request);

    expect(res.body.suggested.disposition.type).toBe("RELIST");
  });

  it("relists a device that dropped a grade, re-graded", async () => {
    const request = requestDoc({
      status: "DeviceReceived",
      device: { gradeAtSale: "EXCELLENT" },
      timeline: [],
    });

    const { res } = await inspect(request, { checklist: allPass({ cosmetic_grade: "FAIR" }) });

    expect(res.body.suggested.disposition).toMatchObject({
      type: "RELIST_REGRADED", grade: "FAIR",
    });
  });

  it("writes the outcome into the timeline, with the grade", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request);

    expect(request.timeline.at(-1)).toMatchObject({
      event: "inspection_completed",
      actor: STAFF.email,
    });
    expect(request.timeline.at(-1).meta.grade).toBe("EXCELLENT");
  });

  it("lets an inspector resume a device that was blocked and then cleared", async () => {
    const request = requestDoc({ status: "ActionRequired", timeline: [] });

    const { res } = await inspect(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("InInspection");
  });
});

// R.7 — offering less, and the customer answering from their email.
describe("offerRevisedRefund", () => {
  const inspected = (overrides = {}) => requestDoc({
    status: "InInspection",
    rmaNumber: "RMA-2026-00412",
    timeline: [],
    inspection: {
      checklist: [
        { key: "cosmetic_grade", result: "fail" },
        { key: "powers_on", result: "pass" },
      ],
      findings: "Deep scratch across the back",
    },
    ...overrides,
  });

  const offer = async (request, body = {}) => {
    // .select("+accessToken") is chained on findById here.
    RefundRequest.findById.mockReturnValue({ select: async () => request });
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      {
        deductions: [{
          type: "DAMAGE", amount: 100,
          reason: "Deep scratch across the back", findingKey: "cosmetic_grade",
          photoIds: ["upcell/returns/photo-1"],
        }],
        ...body,
      },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.offerRevisedRefund(req, res, next);
    return { res, request };
  };

  it("records the offer and moves the return to RevisedOffer", async () => {
    const request = inspected();

    const { res } = await offer(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("RevisedOffer");
    expect(request.refundBreakdown.offeredAmount).toBe(899);
  });

  it("computes the offered amount rather than taking one from the request", async () => {
    const request = inspected();

    // A posted amount is a posted price. The body has no offeredAmount field
    // at all, and one supplied would be ignored.
    const { res } = await offer(request, { offeredAmount: 1 });

    expect(res.body.offeredAmount).toBe(899);
  });

  it("gives the customer five days to answer", async () => {
    const request = inspected();

    await offer(request);

    const days = Math.round(
      (request.refundBreakdown.offerExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)
    );
    expect(days).toBe(5);
  });

  it("emails the offer with the reason behind every deduction", async () => {
    const request = inspected();

    await offer(request);

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain("Deep scratch across the back");
    expect(html).toContain("RMA-2026-00412");
  });

  it("refuses a deduction pointing at a check that passed", async () => {
    const request = inspected();

    const { res } = await offer(request, {
      deductions: [{
        type: "DAMAGE", amount: 100, reason: "Something", findingKey: "powers_on",
        photoIds: ["upcell/returns/photo-1"],
      }],
    });

    expect(res.statusCode).toBe(400);
    expect(request.status).toBe("InInspection");
  });

  it("will not offer on a return that is not being inspected", async () => {
    const request = inspected({ status: "DeviceReceived" });

    const { res } = await offer(request);

    expect(res.statusCode).toBe(400);
  });

  it("stores a hash, never the token that goes in the email", async () => {
    // select:false hides a field from a query that did not ask for it. It is
    // not storage protection, and a plaintext token in the database is a
    // working link for anyone who can read a backup.
    const request = inspected();

    await offer(request);

    expect(request.accessToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints a new token on every offer", async () => {
    // The plaintext cannot be recovered from the hash, so an old link cannot
    // be rebuilt — which settles the rotation question. It is the behaviour to
    // want anyway: two live links answering one offer is two ways to get a
    // different answer, and the email a customer should act on is the one with
    // the current amount in it.
    const first = inspected({ accessToken: "a".repeat(64) });

    await offer(first);

    expect(first.accessToken).not.toBe("a".repeat(64));
    expect(first.accessToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a second offer on the same return", async () => {
    // A second one re-opens a number the customer already has five days to
    // think about, and the accept link in their inbox still points at the
    // first amount.
    const request = inspected({
      refundBreakdown: { offeredAmount: 700, offerExpiresAt: new Date() },
    });

    const { res } = await offer(request);

    expect(res.statusCode).toBe(409);
    expect(res.body.offeredAmount).toBe(700);
  });

  it("will not offer on a return that is already in RevisedOffer", async () => {
    const request = inspected({ status: "RevisedOffer" });

    const { res } = await offer(request);

    expect(res.statusCode).toBe(400);
  });
});

describe("respondToRevisedOffer", () => {
  const offered = (overrides = {}) => requestDoc({
    status: "RevisedOffer",
    accessToken: hashToken("the-real-token"),
    refundBreakdown: {
      offeredAmount: 749.15,
      offerExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
    timeline: [],
    ...overrides,
  });

  // NO_TOKEN rather than undefined: undefined would fall back to the default
  // below and quietly test the happy path instead.
  const NO_TOKEN = Symbol("absent");
  const respond = async (request, { decision = "accept", token = "the-real-token" } = {}) => {
    RefundRequest.findById.mockReturnValue({ select: async () => request });

    const { req, res, next } = makeReqRes(
      {},
      { params: { id: "req1", decision }, query: token === NO_TOKEN ? {} : { token } }
    );
    await controller.respondToRevisedOffer(req, res, next);
    return { res, request };
  };

  it("accepts, and the amount owed becomes the offered amount", async () => {
    const request = offered();

    const { res } = await respond(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("Approved");
    expect(request.calculatedAmount).toBe(749.15);
    expect(request.resolution.outcome).toBe("PARTIAL_ACCEPTED");
  });

  it("declines, which rejects and sends the device back", async () => {
    const request = offered();

    await respond(request, { decision: "decline" });

    expect(request.status).toBe("Rejected");
    expect(request.resolution.outcome).toBe("PARTIAL_DECLINED");
    expect(request.rejectionReason).toMatch(/declined/i);
  });

  it("records the customer as the actor, not a staff member", async () => {
    // Which of the two answered is the first thing anyone asks when an offer
    // is later disputed.
    const request = offered();

    await respond(request);

    expect(request.timeline.at(-1)).toMatchObject({ actorType: "customer" });
  });

  it("refuses a wrong token", async () => {
    const request = offered();

    const { res } = await respond(request, { token: "not-the-token" });

    expect(res.statusCode).toBe(404);
    expect(request.status).toBe("RevisedOffer");
  });

  it("refuses a missing token", async () => {
    const request = offered();

    const { res } = await respond(request, { token: NO_TOKEN });

    expect(res.statusCode).toBe(404);
  });

  it("answers the same way for a wrong token as for a return that does not exist", async () => {
    // A different answer tells whoever is guessing which ids are real.
    const request = offered();
    const wrongToken = await respond(request, { token: "nope" });

    RefundRequest.findById.mockReturnValue({ select: async () => null });
    const { req, res } = makeReqRes({}, { params: { id: "req1", decision: "accept" }, query: { token: "x" } });
    await controller.respondToRevisedOffer(req, res, jest.fn());

    expect(res.statusCode).toBe(wrongToken.res.statusCode);
    expect(res.body.error).toBe(wrongToken.res.body.error);
  });

  it("will not let the same offer be answered twice", async () => {
    const request = offered({ status: "Approved" });

    const { res } = await respond(request);

    expect(res.statusCode).toBe(409);
  });

  it("refuses once the five days have passed", async () => {
    const request = offered({
      refundBreakdown: {
        offeredAmount: 749.15,
        offerExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const { res } = await respond(request);

    expect(res.statusCode).toBe(410);
    expect(request.status).toBe("RevisedOffer");
  });

  it("refuses a decision that is neither accept nor decline", async () => {
    const { res } = await respond(offered(), { decision: "maybe" });

    expect(res.statusCode).toBe(400);
  });
});

// R.8 — the clock, and money actually leaving.
describe("the SLA clock follows the status", () => {
  const { CHECKLIST_ITEMS } = require("../src/constants/inspectionChecklist");
  const allPass = (overrides = {}) => CHECKLIST_ITEMS.map((item) => {
    if (item.measured) return { key: item.key, value: overrides[item.key] ?? 92 };
    if (item.graded) return { key: item.key, grade: overrides[item.key] || "EXCELLENT" };
    return { key: item.key, result: overrides[item.key] || "pass" };
  });
  const fivePhotos = Array.from({ length: 5 }, (_, i) => ({
    url: `https://cdn/p${i}.jpg`, publicId: `upcell/returns/p${i}`,
  }));

  const inspect = async (request, checklist = allPass()) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      { checklist, photos: fivePhotos },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.submitInspection(req, res, next);
    return res;
  };

  it("starts when inspection begins, not when the device arrived", async () => {
    // The promise is two business days from knowing what is owed.
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request);

    expect(request.sla.clockStartedAt).toBeInstanceOf(Date);
    expect(request.sla.dueAt).toBeInstanceOf(Date);
  });

  it("pauses when a locked device puts the ball back with the customer", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request, allPass({ activation_lock: "fail" }));

    expect(request.status).toBe("ActionRequired");
    expect(request.sla.clockPausedAt).toBeInstanceOf(Date);
  });

  it("does not pause while UpCell is the one working", async () => {
    const request = requestDoc({ status: "DeviceReceived", timeline: [] });

    await inspect(request);

    expect(request.sla.clockPausedAt).toBeUndefined();
  });
});

describe("settleRefundRequest", () => {
  const approved = (overrides = {}) => requestDoc({
    status: "Approved",
    rmaNumber: "RMA-2026-00412",
    calculatedAmount: 999,
    timeline: [],
    ...overrides,
  });

  const settle = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      { method: "BANK_TRANSFER", amount: 999, reference: "TRF-99182", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.settleRefundRequest(req, res, next);
    return { res, request };
  };

  it("records the payment and closes the return as Refunded", async () => {
    const request = approved();

    const { res } = await settle(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("Refunded");
    expect(request.resolution.settlementAmount).toBe(999);
    expect(request.resolution.settledBy).toBe(STAFF.email);
  });

  it("insists on a signed receipt for cash", async () => {
    // No bank record stands behind a handover; the receipt is the only proof.
    const request = approved();

    const { res } = await settle(request, { method: "CASH", receiptUrl: undefined, reference: undefined });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/signed receipt/i);
    expect(request.status).toBe("Approved");
  });

  it("accepts cash with one", async () => {
    const request = approved();

    const { res } = await settle(request, {
      method: "CASH", receiptUrl: "https://cdn/receipt.jpg", reference: undefined,
    });

    expect(res.statusCode).toBe(200);
    expect(request.resolution.receiptUrl).toBe("https://cdn/receipt.jpg");
  });

  it("insists on a bank reference for a transfer", async () => {
    const request = approved();

    const { res } = await settle(request, { reference: "" });

    expect(res.statusCode).toBe(400);
  });

  it("refuses to pay more than was agreed", async () => {
    const request = approved();

    const { res } = await settle(request, { amount: 5000 });

    expect(res.statusCode).toBe(400);
    expect(request.status).toBe("Approved");
  });

  it("checks against the revised amount when there was an offer", async () => {
    const request = approved({
      calculatedAmount: 999,
      refundBreakdown: { offeredAmount: 700, finalAmount: 700 },
    });

    const { res } = await settle(request, { amount: 800 });

    expect(res.statusCode).toBe(400);
  });

  it("will not settle a return that has not been approved", async () => {
    const request = approved({ status: "InInspection" });

    const { res } = await settle(request);

    expect(res.statusCode).toBe(400);
  });

  it("records the outcome as a partial acceptance when an offer was accepted", async () => {
    const request = approved({
      timeline: [{ event: "revised_offer_accepted" }],
      refundBreakdown: { offeredAmount: 700, finalAmount: 700 },
    });

    await settle(request, { amount: 700 });

    expect(request.resolution.outcome).toBe("PARTIAL_ACCEPTED");
  });
});

describe("getReturnsDashboard", () => {
  const dashboard = async (statuses, live = []) => {
    RefundRequest.aggregate.mockResolvedValue(statuses);
    RefundRequest.find.mockReturnValue({ select: () => ({ lean: async () => live }) });

    const { req, res, next } = makeReqRes({}, { user: STAFF });
    await controller.getReturnsDashboard(req, res, next);
    return res.json.mock.calls[0][0];
  };

  it("counts each queue a staff member works", async () => {
    const body = await dashboard([
      { _id: "Submitted", count: 3 },
      { _id: "DeviceReceived", count: 2 },
      { _id: "Approved", count: 1 },
      { _id: "LabelIssued", count: 4 },
    ]);

    expect(body.queues).toMatchObject({
      awaitingApproval: 3,
      awaitingInspection: 2,
      awaitingSettlement: 1,
      inTransit: 4,
    });
  });

  it("lists what is already late, worst first", async () => {
    const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000);
    const body = await dashboard([], [
      { _id: "a", rmaNumber: "RMA-1", status: "Approved", sla: { dueAt: hoursAgo(2) } },
      { _id: "b", rmaNumber: "RMA-2", status: "Approved", sla: { dueAt: hoursAgo(30) } },
    ]);

    expect(body.queues.overdue).toBe(2);
    expect(body.overdue.map((entry) => entry.rmaNumber)).toEqual(["RMA-2", "RMA-1"]);
  });

  it("does not count a paused return as late", async () => {
    // The ball is with the customer, so it is not UpCell failing to act.
    const body = await dashboard([], [{
      _id: "a", status: "RevisedOffer",
      sla: { dueAt: new Date(Date.now() - 100000), clockPausedAt: new Date() },
    }]);

    expect(body.queues.overdue).toBe(0);
  });

  it("separates what is waiting on the customer from what is waiting on us", async () => {
    const body = await dashboard([
      { _id: "ActionRequired", count: 2 },
      { _id: "RevisedOffer", count: 1 },
    ]);

    expect(body.queues.waitingOnCustomer).toBe(3);
    expect(body.queues.overdue).toBe(0);
  });
});

// R.9 — getting a rejected device back to its owner.
describe("shipRejectedDeviceBack", () => {
  const rejected = (overrides = {}) => requestDoc({
    status: "Rejected", rmaNumber: "RMA-2026-00412", timeline: [], ...overrides,
  });

  const shipBack = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      { carrier: "FedEx", trackingNumber: "OUT123456789", labelUrl: "https://cdn/out.pdf", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.shipRejectedDeviceBack(req, res, next);
    return { res, request };
  };

  it("records the outbound parcel and moves to ReturnShipped", async () => {
    const request = rejected();

    const { res } = await shipBack(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("ReturnShipped");
    expect(request.shipping.outbound.trackingNumber).toBe("OUT123456789");
  });

  it("charges UpCell, whoever was at fault", async () => {
    // Holding the device until an unhappy customer agrees to pay $12 needs a
    // payment-hold state and somewhere to keep the phone, to recover about the
    // cost of the postage.
    const request = rejected({ faultAttribution: "CUSTOMER" });

    await shipBack(request);

    expect(request.shipping.outbound.paidBy).toBe("UPCELL");
  });

  it("emails the customer the tracking", async () => {
    const request = rejected();

    await shipBack(request);

    expect(mockSendMail.mock.calls[0][0].html).toContain("OUT123456789");
  });

  it("will not send back a return that was not rejected", async () => {
    const request = rejected({ status: "Approved" });

    const { res } = await shipBack(request);

    expect(res.statusCode).toBe(400);
  });

  it("refuses a tracking number already on another open return", async () => {
    const request = rejected();
    RefundRequest.findOne.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: "other", rmaNumber: "RMA-2026-00099" }) }),
    });

    const { res } = await shipBack(request);

    expect(res.statusCode).toBe(409);
  });
});

describe("a rejected return cannot close while UpCell still has the device", () => {
  const closeFrom = async (request) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      { status: "Closed" },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);
    return { res, request };
  };

  it("refuses to close a rejected return with nothing shipped", async () => {
    // Otherwise a phone sits on a shelf with nobody responsible for it and a
    // customer who has stopped being told anything.
    const request = requestDoc({ status: "Rejected", timeline: [] });

    const { res } = await closeFrom(request);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not been sent back/i);
    expect(request.status).toBe("Rejected");
  });

  it("allows it once the device has gone", async () => {
    const request = requestDoc({
      status: "Rejected",
      shipping: { outbound: { shippedAt: new Date() } },
      timeline: [],
    });

    const { res } = await closeFrom(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("Closed");
  });
});

describe("markShipBackUndeliverable", () => {
  const undeliverable = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    const { req, res, next } = makeReqRes(
      { reason: "Refused at the door", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.markShipBackUndeliverable(req, res, next);
    return { res, request };
  };

  it("starts the sixty-day hold", async () => {
    const request = requestDoc({
      status: "ReturnShipped",
      shipping: { outbound: { shippedAt: new Date(), trackingNumber: "OUT1" } },
      timeline: [],
    });

    const { res } = await undeliverable(request);

    expect(res.statusCode).toBe(200);
    const days = Math.round((res.body.disposeAfter - Date.now()) / (24 * 60 * 60 * 1000));
    expect(days).toBe(60);
  });

  it("logs it, so disposal later is not a surprise", async () => {
    const request = requestDoc({
      status: "ReturnShipped",
      shipping: { outbound: { shippedAt: new Date() } },
      timeline: [],
    });

    await undeliverable(request);

    expect(request.timeline.at(-1).event).toBe("ship_back_undeliverable");
  });

  it("refuses when nothing was ever sent back", async () => {
    const request = requestDoc({ status: "Rejected", timeline: [] });

    const { res } = await undeliverable(request);

    expect(res.statusCode).toBe(400);
  });
});

// R.12 — where the device goes once UpCell keeps it.
describe("recordDisposition", () => {
  const SingleVariation = require("../src/models/singleVariation.model");

  const accepted = (overrides = {}) => requestDoc({
    status: "Refunded",
    rmaNumber: "RMA-2026-00412",
    itemIds: ["p1"],
    inspection: { finalGrade: "EXCELLENT" },
    timeline: [],
    ...overrides,
  });

  const decide = async (request, body = {}, { source = "UNKNOWN", modified = 1 } = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    SingleVariation.updateOne = jest.fn(async () => ({ modifiedCount: modified }));
    SingleVariation.findById = jest.fn(() => ({
      select: () => ({ lean: async () => ({ acquisitionSource: source }) }),
    }));

    const { req, res, next } = makeReqRes(
      { type: "RELIST", grade: "EXCELLENT", ...body },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.recordDisposition(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { res, request, SingleVariation };
  };

  it("puts the unit's own listing back up", async () => {
    const request = accepted();

    const { res } = await decide(request);

    expect(res.statusCode).toBe(200);
    expect(res.body.relisted).toBe(true);
    expect(request.disposition.type).toBe("RELIST");
    expect(request.disposition.relistedAt).toBeInstanceOf(Date);
  });

  it("re-prices when the grade dropped", async () => {
    const request = accepted();

    const { res, SingleVariation: model } = await decide(request, {
      type: "RELIST_REGRADED", grade: "GOOD", price: 499,
    });

    expect(res.body.relisted).toBe(true);
    expect(model.updateOne.mock.calls[0][1].$set.price).toBe(499);
  });

  it("refuses a re-grade with no new price", async () => {
    const request = accepted();

    const { res } = await decide(request, { type: "RELIST_REGRADED", grade: "GOOD" });

    expect(res.statusCode).toBe(400);
    expect(request.disposition).toBeUndefined();
  });

  it("does not relist a device going to wholesale", async () => {
    const request = accepted();

    const { res, SingleVariation: model } = await decide(request, {
      type: "WHOLESALE", grade: "FAIR",
    });

    expect(res.body.relisted).toBe(false);
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it("hands back an internal record for anything not relisted", async () => {
    const request = accepted();

    const { res } = await decide(request, { type: "WHOLESALE", grade: "FAIR" });

    expect(res.body.internalRecord).toMatchObject({
      disposition: "WHOLESALE", grade: "FAIR", rmaNumber: "RMA-2026-00412",
    });
  });

  it("refuses the supplier route for a device bought from an individual", async () => {
    // There is nobody to send it back to.
    const request = accepted();

    const { res } = await decide(
      request,
      { type: "RETURN_TO_SUPPLIER", grade: "FAIL", reason: "DOA inside terms" },
      { source: "INDIVIDUAL" }
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/individual/i);
  });

  it("allows it for bulk stock", async () => {
    const request = accepted();

    const { res } = await decide(
      request,
      { type: "RETURN_TO_SUPPLIER", grade: "FAIL", reason: "DOA inside terms" },
      { source: "BULK" }
    );

    expect(res.statusCode).toBe(200);
  });

  it("warns when the relist did not actually change the shelf", async () => {
    // Otherwise a device stays off sale that everyone believes is back on it.
    const request = accepted();

    const { res } = await decide(request, {}, { modified: 0 });

    expect(res.body.relisted).toBe(false);
    expect(res.body.warning).toMatch(/could not be put back on sale/i);
    // The decision is still recorded — the device did come back.
    expect(request.disposition.type).toBe("RELIST");
  });

  it("refuses a write-off with no reason", async () => {
    const request = accepted();

    const { res } = await decide(request, { type: "SCRAP", grade: "FAIL" });

    expect(res.statusCode).toBe(400);
  });

  it("falls back to the grade inspection worked out", async () => {
    const request = accepted();

    await decide(request, { grade: undefined });

    expect(request.disposition.grade).toBe("EXCELLENT");
  });

  it("records who decided, and writes it into the timeline", async () => {
    const request = accepted();

    await decide(request);

    expect(request.disposition.decidedBy).toBe(STAFF.email);
    expect(request.timeline.at(-1)).toMatchObject({
      event: "disposition_recorded", actorType: "staff",
    });
  });

  it("will not route a device that is still going back to the customer", async () => {
    const request = accepted({ status: "Rejected" });

    const { res } = await decide(request);

    expect(res.statusCode).toBe(400);
  });

  it("keeps the IMEI, which is the only thing tying a shelf to a return", async () => {
    const request = accepted();

    await decide(request, { type: "WHOLESALE", grade: "FAIR", imei: "353916000000000" });

    expect(request.device.imei).toBe("353916000000000");
  });
});

describe("an accepted return cannot close without saying where the device went", () => {
  const close = async (request) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());
    const { req, res, next } = makeReqRes(
      { status: "Closed" }, { params: { id: "req1" }, user: STAFF }
    );
    await controller.updateRefundRequestStatus(req, res, next);
    return { res, request };
  };

  it("refuses to close a refunded return with no disposition", async () => {
    // Otherwise the process ends at the refund and the phone becomes something
    // on a shelf nobody is responsible for.
    const request = requestDoc({ status: "Refunded", timeline: [] });

    const { res } = await close(request);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/where the device went/i);
  });

  it("allows it once one is recorded", async () => {
    const request = requestDoc({
      status: "Refunded", disposition: { type: "RESTOCK_NEW" }, timeline: [],
    });

    const { res } = await close(request);

    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("Closed");
  });

  it("does not demand one on a rejected return", async () => {
    // The device is going back to the customer; there is nothing to route.
    const request = requestDoc({
      status: "Rejected",
      shipping: { outbound: { shippedAt: new Date() } },
      timeline: [],
    });

    const { res } = await close(request);

    expect(res.statusCode).toBe(200);
  });
});

// R.13 — what the returns data says.
describe("getReturnsReport", () => {
  const SingleVariation = require("../src/models/singleVariation.model");

  const report = async ({ requests = [], units = 100, query = {} } = {}) => {
    RefundRequest.find.mockReturnValue({ select: () => ({ lean: async () => requests }) });
    SingleVariation.find = jest.fn(() => ({
      select: () => ({ lean: async () => [{ _id: "p1", productName: "iPhone 15", storage: "256GB" }] }),
    }));
    Order.aggregate = jest.fn(async () => [{ units }]);

    const { req, res, next } = makeReqRes({}, { query, user: STAFF });
    await controller.getReturnsReport(req, res, next);
    return res.json.mock.calls[0][0];
  };

  const ret = (overrides = {}) => ({
    status: "Refunded", reasonCode: "CHANGED_MIND", reasonCategory: "PREFERENCE",
    faultAttribution: "CUSTOMER", createdAt: new Date(), itemIds: ["p1"], timeline: [],
    ...overrides,
  });

  it("reports the return rate against units sold", async () => {
    const body = await report({ requests: [ret(), ret()], units: 100 });

    expect(body.metrics.returnRate).toBe(2);
    expect(body.metrics.total).toBe(2);
  });

  it("counts units from paid orders only", async () => {
    // Counting unpaid orders inflates the denominator and quietly flatters the
    // rate — which is exactly the number somebody would use to argue nothing
    // is wrong.
    await report({ requests: [ret()] });

    const pipeline = Order.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.paid).toBe(true);
  });

  it("defaults to the last ninety days", async () => {
    const body = await report({ requests: [] });

    const days = Math.round(
      (new Date(body.window.to) - new Date(body.window.from)) / (24 * 60 * 60 * 1000)
    );
    expect(days).toBe(90);
  });

  it("honours an explicit window", async () => {
    const body = await report({
      requests: [], query: { from: "2026-01-01", to: "2026-03-31" },
    });

    expect(new Date(body.window.from).toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("groups by product, so a bad model stands out", async () => {
    const body = await report({ requests: [ret(), ret()] });

    expect(body.byProduct[0]).toMatchObject({ key: "iPhone 15", total: 2 });
  });

  it("groups by storage too", async () => {
    const body = await report({ requests: [ret()] });

    expect(body.byStorage[0].key).toBe("256GB");
  });

  it("filters to one model when asked", async () => {
    const body = await report({ requests: [ret()], query: { model: "iPad Air" } });

    // The only return is an iPhone 15, so filtering to iPad Air leaves none.
    expect(body.metrics.total).toBe(0);
  });
});

describe("exportReturnsCsv", () => {
  const exportCsv = async (requests = []) => {
    RefundRequest.find.mockReturnValue({
      select: () => ({ sort: () => ({ lean: async () => requests }) }),
    });

    const { req, res, next } = makeReqRes({}, { query: {}, user: STAFF });
    await controller.exportReturnsCsv(req, res, next);
    return res;
  };

  it("writes one row per return, with a header", async () => {
    const res = await exportCsv([
      { rmaNumber: "RMA-2026-00412", status: "Refunded", reasonCode: "CHANGED_MIND" },
    ]);

    const [header, row] = res.body.split("\n");
    expect(header).toContain("rma");
    expect(row).toContain("RMA-2026-00412");
  });

  it("flattens nested fields rather than dumping JSON into a cell", async () => {
    // A cell containing {"type":"OPEN_BOX"} is not something anyone can filter.
    const res = await exportCsv([{
      rmaNumber: "RMA-1", status: "Closed",
      disposition: { type: "OPEN_BOX", grade: "B" },
      resolution: { outcome: "FULL_REFUND", settlementAmount: 999 },
    }]);

    expect(res.body).toContain("OPEN_BOX");
    expect(res.body).toContain("999");
    expect(res.body).not.toContain("{");
  });

  it("serves it as a download with a dated filename", async () => {
    // returns.csv in a downloads folder is indistinguishable from the last four.
    const res = await exportCsv([{ rmaNumber: "RMA-1", status: "Closed" }]);

    expect(res.headers["Content-Type"]).toMatch(/text\/csv/);
    expect(res.headers["Content-Disposition"]).toMatch(/upcell-returns-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv/);
  });

  it("returns an empty body when there is nothing to export", async () => {
    const res = await exportCsv([]);

    expect(res.body).toBe("");
  });
});

// V3.3 — when the customer's 30 days started.
describe("overrideReturnWindow", () => {
  const override = async (request, body = {}) => {
    RefundRequest.findById.mockResolvedValue(request);
    Order.findById.mockResolvedValue(paidOrder());

    const { req, res, next } = makeReqRes(
      {
        startDate: new Date("2026-09-05"),
        note: "Customer emailed to say it arrived on the 5th",
        ...body,
      },
      { params: { id: "req1" }, user: STAFF }
    );
    await controller.overrideReturnWindow(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { res, request };
  };

  it("moves the date the window started from", async () => {
    // The record is sometimes wrong: a carrier marks a parcel delivered when
    // it reaches a depot, and the customer has an email saying otherwise.
    const request = requestDoc({ timeline: [] });

    const { res } = await override(request);

    expect(res.statusCode).toBe(200);
    expect(request.window.startedFrom).toBe("STAFF_OVERRIDE");
    expect(request.window.startDate).toEqual(new Date("2026-09-05"));
  });

  it("moves the closing date with it", async () => {
    const request = requestDoc({ timeline: [] });

    await override(request);

    // 30 days from the overridden start, not from delivery.
    expect(request.window.expiresAt).toEqual(new Date("2026-10-05"));
  });

  it("refuses an override with no note", async () => {
    // It decides whether a return is inside the window, so it moves money.
    // With two or three staff able to do it, an unexplained override is
    // indistinguishable from a favour.
    const request = requestDoc({ timeline: [] });

    const { res } = await override(request, { note: "" });

    expect(res.statusCode).toBe(400);
    expect(request.window).toBeUndefined();
  });

  it("refuses a date in the future", async () => {
    const request = requestDoc({ timeline: [] });

    const { res } = await override(request, {
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(res.statusCode).toBe(400);
  });

  it("records who moved it and what they said", async () => {
    const request = requestDoc({ timeline: [] });

    await override(request);

    expect(request.window.overrideBy).toBe(STAFF.email);
    expect(request.timeline.at(-1)).toMatchObject({
      event: "window_overridden", actorType: "staff",
    });
    expect(request.timeline.at(-1).meta.note).toMatch(/arrived on the 5th/);
  });
});

// V3.6 — freezing the inspection photos past their ninety days.
describe("setDisputeHold", () => {
  const hold = async (request, body) => {
    RefundRequest.findById.mockResolvedValue(request);

    const { req, res, next } = makeReqRes(body, { params: { id: "req1" }, user: STAFF });
    await controller.setDisputeHold(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { res, request };
  };

  it("freezes the photos", async () => {
    const request = requestDoc({ status: "Refunded", timeline: [] });

    const { res } = await hold(request, { disputed: true, reason: "Chargeback filed" });

    expect(res.statusCode).toBe(200);
    expect(request.disputed).toBe(true);
    expect(request.save).toHaveBeenCalled();
  });

  it("records who applied it and why", async () => {
    // A hold that appears without a name on it is worse than no hold: nobody
    // knows what has to close before it can be lifted.
    const request = requestDoc({ status: "Refunded", timeline: [] });

    await hold(request, { disputed: true, reason: "Solicitor letter received" });

    expect(request.timeline.at(-1)).toMatchObject({
      event: "dispute_hold_applied", actor: STAFF.email, actorType: "staff",
    });
    expect(request.timeline.at(-1).meta.reason).toMatch(/solicitor/i);
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "refund_request.dispute_hold_applied" })
    );
  });

  it("lifts it again, and logs that too", async () => {
    const request = requestDoc({ status: "Refunded", disputed: true, timeline: [] });

    const { res } = await hold(request, { disputed: false });

    expect(res.statusCode).toBe(200);
    expect(request.disputed).toBe(false);
    expect(request.timeline.at(-1).event).toBe("dispute_hold_lifted");
  });

  it("deletes nothing when the hold is lifted", async () => {
    // The photos become eligible again on the next purge run, with their
    // original dates. Lifting a hold is not a delete button.
    const photos = [{ publicId: "upcell/returns/inspections/rma-1/a", purgeAfter: new Date("2026-01-01") }];
    const request = requestDoc({ status: "Refunded", disputed: true, timeline: [], inspection: { photos } });

    await hold(request, { disputed: false });

    expect(request.inspection.photos).toEqual(photos);
  });

  it("does not write a second event for a hold that is already on", async () => {
    // The timeline is the dispute record. Repeating a PATCH should not fill
    // it with entries that say nothing happened.
    const request = requestDoc({ status: "Refunded", disputed: true, timeline: [] });

    const { res } = await hold(request, { disputed: true, reason: "Chargeback filed" });

    expect(res.body.unchanged).toBe(true);
    expect(request.timeline).toHaveLength(0);
    expect(request.save).not.toHaveBeenCalled();
  });

  it("404s on a return that is not there", async () => {
    RefundRequest.findById.mockResolvedValue(null);

    const { req, res, next } = makeReqRes(
      { disputed: true, reason: "Chargeback filed" },
      { params: { id: "nope" }, user: STAFF }
    );
    await controller.setDisputeHold(req, res, next);

    expect(res.statusCode).toBe(404);
  });
});

// V3.7 — what the two option endpoints tell the bench form.
describe("the option lists the admin forms are built from", () => {
  const SingleVariation = require("../src/models/singleVariation.model");

  const ask = async (fn, query = {}) => {
    const { req, res, next } = makeReqRes({}, { query, user: STAFF });
    await fn(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return res;
  };

  describe("dispositions", () => {
    it("says what each route makes the form do", async () => {
      // The form reads these rather than keeping its own copy of the rules.
      // A second copy drifts, and the one that drifts is always the one in
      // front of the person filling it in.
      const res = await ask(controller.getDispositions);
      const byType = Object.fromEntries(res.body.dispositions.map((d) => [d.type, d]));

      expect(byType.RELIST).toMatchObject({ relists: true, reprices: false, requiresReason: false });
      expect(byType.RELIST_REGRADED).toMatchObject({ relists: true, reprices: true });
      expect(byType.RETURN_TO_SUPPLIER).toMatchObject({ requiresReason: true, requiresBulkSource: true });
      expect(byType.SCRAP).toMatchObject({ relists: false, requiresReason: true });
    });

    it("sends the grade scale, so the form cannot offer one the server refuses", async () => {
      const res = await ask(controller.getDispositions);

      expect(res.body.grades).toEqual(["EXCELLENT", "GOOD", "FAIR", "FAIL"]);
    });

    it("closes the supplier route for a device bought from an individual", async () => {
      // Answered before the staff member picks it, rather than after they
      // have chosen a route and typed a reason.
      RefundRequest.findById.mockReturnValue({
        select: () => ({ lean: async () => ({ itemIds: ["p1"] }) }),
      });
      SingleVariation.findById = jest.fn(() => ({
        select: () => ({ lean: async () => ({ acquisitionSource: "INDIVIDUAL" }) }),
      }));

      const res = await ask(controller.getDispositions, { requestId: "req1" });
      const supplier = res.body.dispositions.find((d) => d.type === "RETURN_TO_SUPPLIER");

      expect(supplier.unavailableReason).toMatch(/individual/i);
      expect(res.body.dispositions.filter((d) => d.unavailableReason)).toHaveLength(1);
    });

    it("leaves every route open when the source was never recorded", async () => {
      // The field is new and most of the catalogue is not filled in. Hiding a
      // legitimate route on every existing device would cost real recovery
      // value.
      RefundRequest.findById.mockReturnValue({
        select: () => ({ lean: async () => ({ itemIds: ["p1"] }) }),
      });
      SingleVariation.findById = jest.fn(() => ({
        select: () => ({ lean: async () => ({ acquisitionSource: "UNKNOWN" }) }),
      }));

      const res = await ask(controller.getDispositions, { requestId: "req1" });

      expect(res.body.dispositions.every((d) => !d.unavailableReason)).toBe(true);
    });

    it("says nothing about availability when no request was named", async () => {
      const res = await ask(controller.getDispositions);

      expect(res.body.dispositions.every((d) => !("unavailableReason" in d))).toBe(true);
    });
  });

  describe("inspection checklist", () => {
    it("marks the two checks that do not answer with pass or fail", async () => {
      // Without these the form draws three buttons for a battery percentage
      // and the server rejects everything it sends.
      const res = await ask(controller.getInspectionChecklist);
      const byKey = Object.fromEntries(res.body.items.map((item) => [item.key, item]));

      expect(byKey.battery_health).toMatchObject({ measured: true, neverDeducts: true });
      expect(byKey.cosmetic_grade).toMatchObject({ graded: true });
      expect(byKey.powers_on).toMatchObject({ measured: false, graded: false });
    });

    it("sends the grade scale the graded check answers on", async () => {
      const res = await ask(controller.getInspectionChecklist);

      expect(res.body.grades).toEqual(["EXCELLENT", "GOOD", "FAIR", "FAIL"]);
    });
  });
});

// The page the revised-offer email links to. Until now that link went to a
// 404, the offer expired unanswered after five days, and UpCell posted the
// device back at its own cost.
describe("getRevisedOffer", () => {
  const offer = (overrides = {}) => requestDoc({
    rmaNumber: "RMA-2026-00412",
    status: "RevisedOffer",
    accessToken: hashToken("the-real-token"),
    productName: "iPhone 15 Pro",
    calculatedAmount: 999,
    refundBreakdown: {
      refundAmount: 999,
      offeredAmount: 849,
      offerExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      deductions: [{ type: "DAMAGE", amount: 150, reason: "Cracked back glass" }],
    },
    inspection: { findings: "Back glass cracked across two panels." },
    ...overrides,
  });

  const ask = async (doc, token) => {
    RefundRequest.findById.mockReturnValue({ select: () => doc });

    const { req, res, next } = makeReqRes({}, { params: { id: "req1" }, query: { token } });
    await controller.getRevisedOffer(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return res;
  };

  it("shows the amount, the deductions and what was found", async () => {
    const res = await ask(offer(), "the-real-token");

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      rmaNumber: "RMA-2026-00412",
      answerable: true,
      originalAmount: 999,
      offeredAmount: 849,
      findings: "Back glass cracked across two panels.",
    });
    expect(res.body.deductions).toEqual([
      { type: "DAMAGE", amount: 150, reason: "Cracked back glass" },
    ]);
  });

  it("never sends the timeline, the inspection or any staff field", async () => {
    // The document carries the dispute record, photos, notes and the names of
    // whoever handled it. An allowlist is the only version of this that stays
    // correct when somebody adds a field next month.
    const doc = offer();
    doc.timeline = [{ event: "revised_offer_sent", actor: "yasir@upcellit.com" }];
    doc.inspection.photos = [{ url: "https://cdn/x.jpg", publicId: "p1" }];
    doc.disposition = { decidedBy: "yasir@upcellit.com" };

    const res = await ask(doc, "the-real-token");

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/timeline|photos|publicId|decidedBy|upcellit\.com/);
    expect(Object.keys(res.body).sort()).toEqual([
      "answerable", "deductions", "expired", "findings", "offerExpiresAt",
      "offeredAmount", "originalAmount", "productName", "rmaNumber", "status",
    ]);
  });

  it("answers 404 for a wrong token", async () => {
    const res = await ask(offer(), "not-the-token");

    expect(res.statusCode).toBe(404);
    expect(res.body.offeredAmount).toBeUndefined();
  });

  it("answers 404 for a missing return, the same as a wrong token", async () => {
    // Two different answers would turn this into a way of finding out which
    // ids exist.
    const missing = await ask(null, "the-real-token");
    const wrong = await ask(offer(), "nope");

    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual(wrong.body);
  });

  it("answers 404 when no token is given at all", async () => {
    expect((await ask(offer(), undefined)).statusCode).toBe(404);
  });

  it("says it is not answerable once it has been answered", async () => {
    const res = await ask(offer({ status: "Approved" }), "the-real-token");

    expect(res.statusCode).toBe(200);
    expect(res.body.answerable).toBe(false);
    expect(res.body.status).toBe("Approved");
  });

  it("says it is not answerable once it has expired", async () => {
    const res = await ask(offer({
      refundBreakdown: {
        offeredAmount: 849,
        offerExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        deductions: [],
      },
    }), "the-real-token");

    expect(res.body.expired).toBe(true);
    expect(res.body.answerable).toBe(false);
  });
});
