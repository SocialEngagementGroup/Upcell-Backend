const { buildReturnMetrics, groupReturns, toCsv } = require("../src/services/returnReporting");

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysAhead = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const req = (overrides = {}) => ({
  status: "Refunded",
  reasonCode: "CHANGED_MIND",
  reasonCategory: "PREFERENCE",
  faultAttribution: "CUSTOMER",
  createdAt: daysAgo(10),
  timeline: [],
  ...overrides,
});

describe("return rate", () => {
  it("is returns over units sold", () => {
    const metrics = buildReturnMetrics({ requests: [req(), req(), req()], unitsSold: 100 });

    expect(metrics.returnRate).toBe(3);
  });

  it("is unknown, not zero, when nothing was sold", () => {
    // 0% for a month with no sales reads as a triumph.
    expect(buildReturnMetrics({ requests: [], unitsSold: 0 }).returnRate).toBeNull();
  });

  it("rounds to one decimal, which is as precise as this can honestly be", () => {
    expect(buildReturnMetrics({ requests: [req()], unitsSold: 3 }).returnRate).toBe(33.3);
  });
});

describe("breakdowns", () => {
  const mixed = [
    req({ reasonCode: "CHANGED_MIND", reasonCategory: "PREFERENCE", faultAttribution: "CUSTOMER" }),
    req({ reasonCode: "CHANGED_MIND", reasonCategory: "PREFERENCE", faultAttribution: "CUSTOMER" }),
    req({ reasonCode: "WONT_POWER_ON", reasonCategory: "PRODUCT_FAULT", faultAttribution: "UPCELL" }),
  ];

  it("counts by reason", () => {
    expect(buildReturnMetrics({ requests: mixed }).byReason)
      .toEqual({ CHANGED_MIND: 2, WONT_POWER_ON: 1 });
  });

  it("counts by category", () => {
    expect(buildReturnMetrics({ requests: mixed }).byCategory)
      .toEqual({ PREFERENCE: 2, PRODUCT_FAULT: 1 });
  });

  it("counts by who was at fault, which is the number that costs money", () => {
    expect(buildReturnMetrics({ requests: mixed }).byAttribution)
      .toEqual({ CUSTOMER: 2, UPCELL: 1 });
  });

  it("derives the category when only the code was stored", () => {
    const older = [req({ reasonCode: "WRONG_MODEL", reasonCategory: undefined })];

    expect(buildReturnMetrics({ requests: older }).byCategory).toEqual({ FULFILMENT: 1 });
  });

  it("ignores requests with no reason rather than inventing a bucket", () => {
    const metrics = buildReturnMetrics({ requests: [req({ reasonCode: null, reasonCategory: null })] });

    expect(metrics.byReason).toEqual({});
  });
});

describe("reject rate", () => {
  it("is measured against returns that concluded, not every return opened", () => {
    // A busy month of in-flight returns would otherwise make the reject rate
    // look like it fell.
    const requests = [
      req({ status: "Rejected" }),
      req({ status: "Refunded" }),
      req({ status: "InTransit" }),
      req({ status: "DeviceReceived" }),
    ];

    const metrics = buildReturnMetrics({ requests });

    expect(metrics.concluded).toBe(2);
    expect(metrics.rejectRate).toBe(50);
  });

  it("counts a shipped-back device as rejected", () => {
    const metrics = buildReturnMetrics({ requests: [req({ status: "ReturnShipped" })] });

    expect(metrics.rejectRate).toBe(100);
  });

  it("is unknown when nothing has concluded", () => {
    expect(buildReturnMetrics({ requests: [req({ status: "Submitted" })] }).rejectRate).toBeNull();
  });
});

describe("days to settle", () => {
  it("averages from request to settlement", () => {
    const requests = [
      req({ createdAt: daysAgo(10), resolution: { settledAt: daysAgo(6) } }),
      req({ createdAt: daysAgo(10), resolution: { settledAt: daysAgo(4) } }),
    ];

    expect(buildReturnMetrics({ requests }).averageDaysToSettle).toBe(5);
  });

  it("ignores returns that have not settled", () => {
    const requests = [
      req({ createdAt: daysAgo(10), resolution: { settledAt: daysAgo(8) } }),
      req({ status: "InInspection" }),
    ];

    expect(buildReturnMetrics({ requests }).averageDaysToSettle).toBe(2);
  });

  it("is unknown when nothing has settled", () => {
    expect(buildReturnMetrics({ requests: [req({ status: "Submitted" })] }).averageDaysToSettle)
      .toBeNull();
  });
});

describe("SLA breaches", () => {
  it("counts a settlement that landed after its deadline", () => {
    const requests = [req({
      sla: { dueAt: daysAgo(5) },
      resolution: { settledAt: daysAgo(3) },
    })];

    expect(buildReturnMetrics({ requests }).slaBreaches).toBe(1);
  });

  it("does not count one settled in time", () => {
    const requests = [req({
      sla: { dueAt: daysAgo(3) },
      resolution: { settledAt: daysAgo(5) },
    })];

    expect(buildReturnMetrics({ requests }).slaBreaches).toBe(0);
  });

  it("counts an unsettled return whose deadline has already passed", () => {
    // Still late, and the fact that nobody has settled it is the point.
    const requests = [req({ status: "Approved", sla: { dueAt: daysAgo(2) } })];

    expect(buildReturnMetrics({ requests }).slaBreaches).toBe(1);
  });

  it("does not count one still inside its deadline", () => {
    const requests = [req({ status: "Approved", sla: { dueAt: daysAhead(1) } })];

    expect(buildReturnMetrics({ requests }).slaBreaches).toBe(0);
  });

  it("measures only against returns that were given a deadline", () => {
    const requests = [
      req({ status: "Approved", sla: { dueAt: daysAgo(2) } }),
      req({ status: "Submitted" }),
    ];

    const metrics = buildReturnMetrics({ requests });

    expect(metrics.slaBreachRate).toBe(100);
  });
});

describe("revised offers", () => {
  const withOffer = (accepted) => req({
    timeline: [
      { event: "revised_offer_sent" },
      ...(accepted ? [{ event: "revised_offer_accepted" }] : []),
    ],
  });

  it("measures acceptance against offers actually sent", () => {
    const metrics = buildReturnMetrics({
      requests: [withOffer(true), withOffer(false), req()],
    });

    expect(metrics.revisedOffersSent).toBe(2);
    expect(metrics.revisedOfferAcceptanceRate).toBe(50);
  });

  it("is unknown when none were sent", () => {
    expect(buildReturnMetrics({ requests: [req()] }).revisedOfferAcceptanceRate).toBeNull();
  });
});

describe("dispositions", () => {
  it("counts the mix", () => {
    const requests = [
      req({ disposition: { type: "RESTOCK_NEW" } }),
      req({ disposition: { type: "OPEN_BOX" } }),
      req({ disposition: { type: "OPEN_BOX" } }),
    ];

    expect(buildReturnMetrics({ requests }).byDisposition)
      .toEqual({ RESTOCK_NEW: 1, OPEN_BOX: 2 });
  });

  it("totals the value of devices that got a route", () => {
    const requests = [
      req({ disposition: { type: "RESTOCK_NEW" }, refundBreakdown: { orderAmount: 999 } }),
      req({ disposition: { type: "WHOLESALE" }, refundBreakdown: { orderAmount: 500.5 } }),
      req({ refundBreakdown: { orderAmount: 100 } }),
    ];

    expect(buildReturnMetrics({ requests }).dispositionedValue).toBe(1499.5);
  });
});

describe("groupReturns", () => {
  it("puts the worst offender first", () => {
    // The whole reason to look at this is to find the model that stands out.
    const requests = [
      req({ productName: "iPhone 15" }),
      req({ productName: "iPad Air" }),
      req({ productName: "iPhone 15" }),
      req({ productName: "iPhone 15" }),
    ];

    const groups = groupReturns(requests, "productName");

    expect(groups[0]).toMatchObject({ key: "iPhone 15", total: 3 });
    expect(groups[1]).toMatchObject({ key: "iPad Air", total: 1 });
  });

  it("counts rejections within each group", () => {
    const requests = [
      req({ productName: "iPhone 15", status: "Rejected" }),
      req({ productName: "iPhone 15", status: "Refunded" }),
    ];

    expect(groupReturns(requests, "productName")[0].rejected).toBe(1);
  });

  it("breaks each group down by reason, which is where a bad batch shows", () => {
    const requests = [
      req({ productName: "iPhone 15", reasonCode: "WONT_POWER_ON" }),
      req({ productName: "iPhone 15", reasonCode: "WONT_POWER_ON" }),
      req({ productName: "iPhone 15", reasonCode: "CHANGED_MIND" }),
    ];

    expect(groupReturns(requests, "productName")[0].reasons)
      .toEqual({ WONT_POWER_ON: 2, CHANGED_MIND: 1 });
  });

  it("buckets missing values rather than dropping the row", () => {
    expect(groupReturns([req({ productName: undefined })], "productName")[0].key).toBe("Unknown");
  });
});

describe("toCsv", () => {
  it("writes a header from the keys", () => {
    expect(toCsv([{ reason: "CHANGED_MIND", count: 3 }]))
      .toBe("reason,count\nCHANGED_MIND,3");
  });

  it("quotes a value containing a comma", () => {
    // A product name with a comma shifts every column after it by one, and
    // does it silently.
    expect(toCsv([{ name: "iPhone 15, 256GB" }])).toBe('name\n"iPhone 15, 256GB"');
  });

  it("doubles quotes inside a quoted value", () => {
    expect(toCsv([{ note: 'He said "fine"' }])).toBe('note\n"He said ""fine"""');
  });

  it("quotes a value containing a newline", () => {
    expect(toCsv([{ note: "line one\nline two" }])).toBe('note\n"line one\nline two"');
  });

  it("writes empty for null and undefined rather than the word", () => {
    expect(toCsv([{ a: null, b: undefined }])).toBe("a,b\n,");
  });

  it("takes an explicit column order when given one", () => {
    expect(toCsv([{ b: 2, a: 1 }], ["a", "b"])).toBe("a,b\n1,2");
  });

  it("returns nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});
