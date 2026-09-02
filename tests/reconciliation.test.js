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
  PaymentEventLog.find.mockImplementation((query) => ({
    lean: async () => byType[query.eventType] || [],
  }));
};

const withOrders = (rows = []) => {
  Order.find.mockImplementation(() => ({ lean: async () => rows }));
  Order.countDocuments.mockResolvedValue(0);
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => "" });
  EmailConfig.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({ enableErrorAlerts: true }),
  });
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

describe("reconciliation — warnings", () => {
  it("flags a paid order with no bank transaction id", async () => {
    Order.find.mockImplementation((query) => ({
      lean: async () => (query.paid === true ? [{ _id: ORDER_ID }] : []),
    }));
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
