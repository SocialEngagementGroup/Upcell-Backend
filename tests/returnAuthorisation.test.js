const {
  issueRma,
  dueReminder,
  hasExpired,
  RMA_EXPIRY_DAYS,
  REMINDER_DAYS,
} = require("../src/services/returnAuthorisation");

const now = new Date("2026-09-10T12:00:00Z");
const daysAfter = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

describe("issueRma", () => {
  const deps = (overrides = {}) => ({
    RefundRequest: {
      findOne: jest.fn(() => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) })),
      exists: jest.fn(async () => false),
    },
    issueRmaNumber: jest.fn(async () => "RMA-2026-00001"),
    now,
    ...overrides,
  });

  it("gives the request a number and a clock", async () => {
    const request = {};

    await issueRma(request, deps());

    expect(request.rmaNumber).toBe("RMA-2026-00001");
    expect(request.rma.issuedAt).toEqual(now);
    expect(request.rma.expiresAt).toEqual(daysAfter(RMA_EXPIRY_DAYS));
  });

  it("starts with no reminders sent", async () => {
    const request = {};

    await issueRma(request, deps());

    expect(request.rma.remindersSent).toEqual([]);
  });

  it("expires 14 days out", async () => {
    expect(RMA_EXPIRY_DAYS).toBe(14);
  });

  it("asks the collection for the highest number, not a counter", async () => {
    // Two approvals in the same instant must not both take the same number, so
    // the check has to be against what is actually stored.
    const d = deps();
    await issueRma({}, d);

    const call = d.issueRmaNumber.mock.calls[0][0];
    expect(typeof call.findLatest).toBe("function");
    expect(typeof call.exists).toBe("function");
  });
});

describe("dueReminder", () => {
  const withIssuedAt = (daysAgo, remindersSent = []) => ({
    rma: {
      issuedAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000),
      remindersSent,
    },
  });

  it("sends nothing before day 7", () => {
    expect(dueReminder(withIssuedAt(6), now)).toBeNull();
  });

  it("sends day 7 on day 7", () => {
    expect(dueReminder(withIssuedAt(7), now)).toBe(7);
  });

  it("sends day 12 on day 12", () => {
    expect(dueReminder(withIssuedAt(12), now)).toBe(12);
  });

  it("never sends the same reminder twice", () => {
    // A daily job re-run after a crash must not email the customer again.
    expect(dueReminder(withIssuedAt(8, [7]), now)).toBeNull();
  });

  it("sends only the latest when the job has not run for days", () => {
    // Day 7 followed by day 12 tomorrow would be two emails about the same
    // deadline, the first of them already stale.
    expect(dueReminder(withIssuedAt(13, []), now)).toBe(12);
  });

  it("stops once both have gone out", () => {
    expect(dueReminder(withIssuedAt(20, [7, 12]), now)).toBeNull();
  });

  it("says nothing for a request that was never authorised", () => {
    expect(dueReminder({}, now)).toBeNull();
    expect(dueReminder({ rma: {} }, now)).toBeNull();
  });

  it("reminds before it lapses, not after", () => {
    for (const day of REMINDER_DAYS) {
      expect(day).toBeLessThan(RMA_EXPIRY_DAYS);
    }
  });
});

describe("hasExpired", () => {
  it("is false while the authorisation is live", () => {
    expect(hasExpired({ rma: { expiresAt: daysAfter(1) } }, now)).toBe(false);
  });

  it("is true once the deadline has passed", () => {
    expect(hasExpired({ rma: { expiresAt: new Date(now.getTime() - 1) } }, now)).toBe(true);
  });

  it("is false on a request that was never authorised", () => {
    // Nothing was promised, so nothing can lapse. Treating this as expired
    // would sweep away requests still waiting for staff to look at them.
    expect(hasExpired({}, now)).toBe(false);
    expect(hasExpired({ rma: {} }, now)).toBe(false);
  });
});
