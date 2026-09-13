const {
  buildReturnFlags,
  summariseForQueue,
  HIGH_VALUE_THRESHOLD,
  REPEAT_RETURN_THRESHOLD,
} = require("../src/services/returnRiskFlags");

const now = new Date("2026-09-10T12:00:00Z");
const daysBefore = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

const request = (overrides = {}) => ({
  reasonCode: "CHANGED_MIND",
  faultAttribution: "CUSTOMER",
  createdAt: now,
  userId: "user_1",
  ...overrides,
});

const order = (overrides = {}) => ({
  totalCents: 50000,
  deliveredAt: daysBefore(3),
  ...overrides,
});

const codes = (flags) => flags.map((flag) => flag.code);

describe("outside the window", () => {
  it("does not flag a return well inside the window", () => {
    const flags = buildReturnFlags({
      request: request({ createdAt: daysBefore(0) }),
      order: order({ deliveredAt: daysBefore(13) }),
      now,
    });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });

  it("does not flag day 15 any more — every reason gets 30 days", () => {
    // This used to be outside a 14-day change-of-mind window.
    const flags = buildReturnFlags({
      request: request({ createdAt: now }),
      order: order({ deliveredAt: daysBefore(15) }),
      now,
    });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });

  it("flags one asked for on day 31", () => {
    const flags = buildReturnFlags({
      request: request({ createdAt: now }),
      order: order({ deliveredAt: daysBefore(31) }),
      now,
    });

    expect(codes(flags)).toContain("OUTSIDE_WINDOW");
  });

  it("does not flag day 30 itself", () => {
    const flags = buildReturnFlags({
      request: request({ createdAt: now }),
      order: order({ deliveredAt: daysBefore(30) }),
      now,
    });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });

  it("judges by when the customer asked, not by when a staff member looks", () => {
    // A request submitted on day 10 and reviewed on day 20 was in time. Flagging
    // it would punish the customer for UpCell's queue.
    const flags = buildReturnFlags({
      request: request({ createdAt: daysBefore(10) }),
      order: order({ deliveredAt: daysBefore(20) }),
      now,
    });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });

  it("says nothing about the window when the order was never delivered", () => {
    const flags = buildReturnFlags({ request: request(), order: order({ deliveredAt: null }), now });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });
});

describe("high value", () => {
  it("flags an order at the threshold", () => {
    const flags = buildReturnFlags({
      request: request(),
      order: order({ totalCents: HIGH_VALUE_THRESHOLD * 100 }),
      now,
    });

    expect(codes(flags)).toContain("HIGH_VALUE");
  });

  it("does not flag an order a cent below it", () => {
    const flags = buildReturnFlags({
      request: request(),
      order: order({ totalCents: HIGH_VALUE_THRESHOLD * 100 - 1 }),
      now,
    });

    expect(codes(flags)).not.toContain("HIGH_VALUE");
  });
});

describe("repeat returner", () => {
  it("flags a customer at the threshold", () => {
    const flags = buildReturnFlags({
      request: request(), order: order(), priorReturns: REPEAT_RETURN_THRESHOLD, now,
    });

    expect(codes(flags)).toContain("REPEAT_RETURNER");
  });

  it("does not flag one below it", () => {
    const flags = buildReturnFlags({
      request: request(), order: order(), priorReturns: REPEAT_RETURN_THRESHOLD - 1, now,
    });

    expect(codes(flags)).not.toContain("REPEAT_RETURNER");
  });
});

describe("attribution", () => {
  it("flags a reason and an attribution that disagree", () => {
    // Somebody changed one without the other. It no longer changes what
    // anyone pays, but it does mean the reporting blames the wrong party.
    const flags = buildReturnFlags({
      request: request({ reasonCode: "WONT_POWER_ON", faultAttribution: "CUSTOMER" }),
      order: order(),
      now,
    });

    expect(codes(flags)).toContain("ATTRIBUTION_MISMATCH");
  });

  it("says nothing when they agree", () => {
    const flags = buildReturnFlags({
      request: request({ reasonCode: "WONT_POWER_ON", faultAttribution: "UPCELL" }),
      order: order(),
      now,
    });

    expect(codes(flags)).not.toContain("ATTRIBUTION_MISMATCH");
  });

  it("flags OTHER with nobody yet assigned the fault", () => {
    const flags = buildReturnFlags({
      request: request({ reasonCode: "OTHER", faultAttribution: null }),
      order: order(),
      now,
    });

    expect(codes(flags)).toContain("ATTRIBUTION_UNDECIDED");
  });

  it("stops flagging OTHER once a staff member has decided", () => {
    const flags = buildReturnFlags({
      request: request({ reasonCode: "OTHER", faultAttribution: "UPCELL" }),
      order: order(),
      now,
    });

    expect(codes(flags)).not.toContain("ATTRIBUTION_UNDECIDED");
  });
});

describe("requests that predate reason codes", () => {
  it("says so, as information rather than a problem", () => {
    const flags = buildReturnFlags({
      request: request({ reasonCode: null }), order: order(), now,
    });

    const flag = flags.find((entry) => entry.code === "NO_REASON_CODE");
    expect(flag.severity).toBe("info");
  });

  it("does not try to judge the window without a reason", () => {
    const flags = buildReturnFlags({
      request: request({ reasonCode: null, createdAt: now }),
      order: order({ deliveredAt: daysBefore(90) }),
      now,
    });

    expect(codes(flags)).not.toContain("OUTSIDE_WINDOW");
  });
});

describe("summariseForQueue", () => {
  it("gives the row everything a staff member reads before approving", () => {
    const summary = summariseForQueue({
      request: request(),
      order: order({ totalCents: 129900, deliveredAt: daysBefore(4) }),
      priorReturns: 1,
      now,
    });

    expect(summary).toMatchObject({
      orderValue: 1299,
      daysSinceDelivery: 4,
      reasonCode: "CHANGED_MIND",
      reasonCategory: "PREFERENCE",
      faultAttribution: "CUSTOMER",
      priorReturns: 1,
    });
    expect(Array.isArray(summary.flags)).toBe(true);
  });

  it("copes with an order it could not load", () => {
    // A row whose order was deleted still has to render, not crash the queue.
    const summary = summariseForQueue({ request: request(), order: undefined, now });

    expect(summary.orderValue).toBeNull();
    expect(summary.daysSinceDelivery).toBeNull();
  });

  it("returns a clean row when nothing is wrong", () => {
    const summary = summariseForQueue({
      request: request(),
      order: order({ totalCents: 50000, deliveredAt: daysBefore(2) }),
      priorReturns: 0,
      now,
    });

    expect(summary.flags).toEqual([]);
  });
});
