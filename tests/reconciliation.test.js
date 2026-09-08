process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.googleapis.com/test";
process.env.RESEND_KEY = "test-resend-key";

const mockSendMail = jest.fn().mockResolvedValue({ sent: true, id: "mail_1" });
jest.mock("../src/services/mailService", () => ({
  sendMail: (...args) => mockSendMail(...args),
  getMessageId: jest.fn(),
}));

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));

jest.mock("../src/models/order.model");
jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/models/emailConfig.model");

const Order = require("../src/models/order.model");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const { EmailConfig } = require("../src/models/emailConfig.model");
const { runReconciliation } = require("../src/services/reconciliation");

const ORDER_ID = "6a79f7298341f33d9a65b0b7";

// Each reconciliation query is a different find(); route by what it asks for
// rather than by call order, so adding a check doesn't break every test.
const withEvents = (byType) => {
  PaymentEventLog.find.mockImplementation((query) => {
    // The sweep asks a different question: "any event at all for these orders?"
    const rows = query.orderId ? byType.byOrderId || [] : byType[query.eventType] || [];
    return { lean: async () => rows, select: () => ({ lean: async () => rows }) };
  });
};

// Two of the checks ask a narrower question than the rest, and answering them
// with the same rows would make every test about open reviews also a test about
// expiring them. Route by the shape of the query, and default both to empty so
// a test only sees the check it is about.
const withOrders = (rows = [], { staleReviews = [], blocked = [] } = {}) => {
  Order.find.mockImplementation((query = {}) => {
    let out = rows;
    if (query.updatedAt) out = staleReviews;
    else if (query.fulfilmentBlocked) out = blocked;
    return {
      lean: async () => out,
      select: () => ({ lean: async () => out }),
    };
  });
  Order.countDocuments.mockResolvedValue(0);
  Order.updateMany.mockResolvedValue({ modifiedCount: 0 });
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => "" });
  EmailConfig.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({ enableErrorAlerts: true }),
  });
  PaymentEventLog.create.mockResolvedValue({});
  withEvents({});
  withOrders([]);
});

describe("reconciliation — finding money problems", () => {
  it("reports nothing when every record agrees", async () => {
    const report = await runReconciliation();

    expect(report.clean).toBe(true);
    expect(report.critical).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("raises a payment the bank confirmed against no order", async () => {
    withEvents({
      unmatched_confirmation: [
        {
          gatewayReference: "7882749437566123004007",
          metadata: { reason: "no_such_order" },
        },
      ],
    });

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(1);
    expect(report.critical[0]).toContain("7882749437566123004007");
    expect(report.clean).toBe(false);
  });

  it("raises an order the bank replied about that never settled", async () => {
    // Exactly the shape the req_reference_number bug produced: a confirmation
    // arrived and the order stayed pending. This check would have caught it.
    withEvents({
      webhook_received: [{ metadata: { reference_number: ORDER_ID } }],
    });
    withOrders([
      {
        _id: ORDER_ID,
        email: "buyer@example.com",
        status: "pending_payment",
        line_items: [
          { price_data: { product_data: { metadata: { totalPaid: 1109.5 } } } },
        ],
      },
    ]);

    const report = await runReconciliation();

    expect(report.critical.join(" ")).toContain(ORDER_ID);
    expect(report.critical.join(" ")).toContain("$1109.50");
  });

  it("ignores a malformed reference instead of querying with it", async () => {
    withEvents({ webhook_received: [{ metadata: { reference_number: undefined } }] });

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(0);
    // A findById-shaped query on undefined is what used to throw a CastError.
    expect(Order.find).not.toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() })
    );
  });
});

describe("reconciliation — alerting", () => {
  const oneCritical = () =>
    withEvents({
      unmatched_confirmation: [{ gatewayReference: "T1", metadata: { reason: "no_such_order" } }],
    });

  it("sends to both Google Chat and email when something is wrong", async () => {
    oneCritical();

    await runReconciliation();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://chat.googleapis.com/test",
      expect.objectContaining({ method: "POST" })
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" })
    );
  });

  it("respects the admin switch that mutes alerts during testing", async () => {
    EmailConfig.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ enableErrorAlerts: false }),
    });
    oneCritical();

    const report = await runReconciliation();

    // Still found and reported in the returned data — only the sending is muted.
    expect(report.critical).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("still returns a report when Google Chat is unreachable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    oneCritical();

    const report = await runReconciliation();

    // A dead webhook must not swallow the finding or crash the scheduled run.
    expect(report.critical).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("never throws when the database is unavailable", async () => {
    PaymentEventLog.find.mockImplementation(() => {
      throw new Error("connection lost");
    });

    const report = await runReconciliation();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("connection lost");
  });
});

describe("reconciliation — closing abandoned checkouts", () => {
  const abandoned = [{ _id: "6a79f7298341f33d9a65b0b1" }, { _id: "6a79f7298341f33d9a65b0b2" }];

  it("closes checkouts the bank never replied about", async () => {
    withOrders(abandoned);
    withEvents({ byOrderId: [] });
    Order.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const report = await runReconciliation();

    expect(Order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: abandoned.map((o) => o._id) } }),
      { $set: { status: "payment failed" } }
    );
    expect(report.info.join(" ")).toContain("2 abandoned checkouts closed");
  });

  it("never closes an order the bank did reply about", async () => {
    // This is the dangerous case. An order the bank spoke about that is still
    // pending means something broke on our side — marking it "payment failed"
    // could bury a real payment. It stays pending for a person to resolve.
    withOrders(abandoned);
    withEvents({ byOrderId: [{ orderId: abandoned[0]._id }, { orderId: abandoned[1]._id }] });

    await runReconciliation();

    expect(Order.updateMany).not.toHaveBeenCalled();
  });

  it("closes only the untouched ones when some had bank replies", async () => {
    withOrders(abandoned);
    withEvents({ byOrderId: [{ orderId: abandoned[0]._id }] });
    Order.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await runReconciliation();

    expect(Order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: [abandoned[1]._id] } }),
      expect.anything()
    );
  });

  it("does nothing when there is nothing to close", async () => {
    withOrders([]);
    withEvents({});

    const report = await runReconciliation();

    expect(Order.updateMany).not.toHaveBeenCalled();
    expect(report.info.join(" ")).not.toContain("closed automatically");
  });

  it("keeps the findings when closing them fails", async () => {
    // The sweep is the only part of this service that writes, so it is the
    // only part that can fail in a new way. Sharing the outer catch meant a
    // failure here threw away every problem found above it — the report would
    // come back empty at exactly the moment it mattered most.
    withOrders(abandoned);
    withEvents({
      unmatched_confirmation: [{ gatewayReference: "T1", metadata: { reason: "no_such_order" } }],
    });
    Order.updateMany.mockRejectedValue(new Error("write failed"));

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(1);
    expect(report.critical[0]).toContain("T1");
    expect(report.warnings.join(" ")).toContain("Could not close abandoned checkouts");
  });
});

describe("reconciliation — warnings", () => {
  it("flags a paid order with no bank transaction id", async () => {
    Order.find.mockImplementation((query) => {
      const rows = query.paid === true ? [{ _id: ORDER_ID }] : [];
      return { lean: async () => rows, select: () => ({ lean: async () => rows }) };
    });
    Order.countDocuments.mockResolvedValue(0);

    const report = await runReconciliation();

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("cannot be refunded");
    expect(report.critical).toHaveLength(0);
  });

  it("counts abandoned checkouts as information, not an alarm", async () => {
    Order.countDocuments.mockResolvedValue(5);

    const report = await runReconciliation();

    expect(report.info[0]).toContain("5 checkouts");
    expect(report.clean).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// A payment the bank is checking by hand holds its devices off sale for up to a
// week, and nothing closes it automatically the way an abandoned cart is closed.
// If the daily report stayed silent about it, the long hold would quietly cost
// sales — naming them is what makes that hold safe to grant.
describe("reconciliation — payments the bank is still reviewing", () => {
  // Every check calls Order.find with a different question. Route by status so
  // one under-review order does not also answer the stuck and unreferenced
  // checks and produce three findings from one row.
  const withOrdersByStatus = (byStatus) => {
    Order.find.mockImplementation((query = {}) => {
      // The expiry sweep asks for under_review AND an updatedAt cutoff. Answer
      // it separately, or an order that is merely open would also look overdue
      // and every test here would become a test of the sweep as well.
      if (query.updatedAt) return leanRows(byStatus.staleReviews || []);
      const rows = query.status ? byStatus[query.status] || [] : byStatus.other || [];
      return leanRows(rows);
    });
    Order.countDocuments.mockResolvedValue(0);
    Order.updateMany.mockResolvedValue({ modifiedCount: 0 });
  };

  const leanRows = (rows) => ({
    lean: async () => rows,
    select: () => ({ lean: async () => rows }),
  });

  const reviewedOrder = (hoursAgo) => ({
    _id: ORDER_ID,
    email: "buyer@example.com",
    updatedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    line_items: [
      { quantity: 1, price_data: { product_data: { metadata: { totalPaid: 1109.5 } } } },
    ],
  });

  it("names an order sitting under review, with how long it has waited", async () => {
    withOrdersByStatus({ under_review: [reviewedOrder(30)] });

    const report = await runReconciliation();

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(ORDER_ID);
    expect(report.warnings[0]).toContain("30 hours");
    expect(report.warnings[0]).toContain("$1109.50");
    expect(report.clean).toBe(false);
  });

  it("says one hour without an s", async () => {
    withOrdersByStatus({ under_review: [reviewedOrder(1)] });

    const report = await runReconciliation();

    expect(report.warnings[0]).toContain("for 1 hour.");
  });

  it("is a warning, not a critical — the money is not lost, only undecided", async () => {
    withOrdersByStatus({ under_review: [reviewedOrder(5)] });

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
  });

  it("stays quiet when nothing is under review", async () => {
    withOrdersByStatus({});

    const report = await runReconciliation();

    expect(report.clean).toBe(true);
  });

  it("closes a review nobody answered inside the pending window", async () => {
    // 24 hours. One full business day, then it stops being the customer's
    // problem to wonder about.
    withOrdersByStatus({ staleReviews: [{ ...reviewedOrder(30), boaTransactionId: "788274" }] });
    Order.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const report = await runReconciliation();

    const [filter, update] = Order.updateMany.mock.calls[0];
    expect(filter.status).toBe("under_review");
    expect(update.$set.status).toBe("payment failed");
    expect(update.$set.paid).toBe(false);
    expect(update.$set.reviewAutoRejectedAt).toBeInstanceOf(Date);
  });

  it("says plainly that an auto-rejected authorisation still needs reversing by hand", async () => {
    // The code cannot return money — Secure Acceptance keys only take it. A
    // report that implied otherwise would leave a customer's funds held with
    // everyone believing they had been released.
    withOrdersByStatus({ staleReviews: [{ ...reviewedOrder(48), boaTransactionId: "788274" }] });
    Order.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(1);
    expect(report.critical[0]).toContain("788274");
    expect(report.critical[0]).toMatch(/reverse it by hand/i);
  });

  it("records the auto-rejection as a payment event", async () => {
    withOrdersByStatus({ staleReviews: [reviewedOrder(26)] });
    Order.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await runReconciliation();

    const types = PaymentEventLog.create.mock.calls.map((call) => call[0].eventType);
    expect(types).toContain("review_auto_rejected");
  });

  it("reports a paid order that has nothing left to ship", async () => {
    // The accepted cost of never holding stock for a human: the review came
    // back yes, the phone had already gone to somebody else.
    Order.find.mockImplementation((query = {}) => {
      if (query.fulfilmentBlocked) {
        return leanRows([
          {
            ...reviewedOrder(2),
            fulfilmentBlocked: true,
            fulfilmentBlockReason: "Review accepted after the device had already sold",
          },
        ]);
      }
      return leanRows([]);
    });

    const report = await runReconciliation();

    expect(report.critical).toHaveLength(1);
    expect(report.critical[0]).toContain("paid but cannot be fulfilled");
  });

  it("does not sweep a reviewed order away as an abandoned checkout", async () => {
    // The sweep only ever touches pending_payment. An order under review has a
    // status of its own precisely so this can never reach it — that sweep is
    // what would otherwise have deleted it twelve hours in.
    withOrdersByStatus({ under_review: [reviewedOrder(20)] });

    await runReconciliation();

    const sweptStatuses = Order.updateMany.mock.calls.map((call) => call[0].status);
    expect(sweptStatuses).not.toContain("under_review");
  });
});
