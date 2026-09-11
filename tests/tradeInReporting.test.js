// What the trade-in data says.
//
// The mirror of the returns report: that one asks which model keeps coming
// back, this one asks which model UpCell keeps quoting too high for. The
// numbers that matter are the rates, and a rate is mostly its denominator.

const {
  buildTradeInMetrics,
  groupTradeIns,
  quotedCents,
  agreedCents,
  hadRevisedOffer,
} = require("../src/services/tradeInReporting");

const DAY = 24 * 60 * 60 * 1000;
const CREATED = new Date("2026-08-01T00:00:00Z");

const request = (over = {}) => ({
  status: "Paid",
  modelTitle: "iPhone 13 128GB",
  estimateCents: 40000,
  createdAt: CREATED,
  timeline: [],
  ...over,
});

const paidAfter = (days, over = {}) => request({
  status: "Paid",
  payout: { paidAt: new Date(CREATED.getTime() + days * DAY), amountCents: 40000 },
  ...over,
});

describe("reading the amounts off a record", () => {
  it("prefers cents when the record has them", () => {
    expect(quotedCents({ estimateCents: 40000, estimate: 999 })).toBe(40000);
  });

  it("converts an older record's dollars", () => {
    // Reading $400 as 400 cents would report it as $4, which is the kind of
    // number somebody acts on.
    expect(quotedCents({ estimate: 400 })).toBe(40000);
  });

  it("says nothing rather than zero when there is no quote", () => {
    expect(quotedCents({})).toBeNull();
  });

  it("takes the revised offer as what was agreed", () => {
    expect(agreedCents({ estimateCents: 40000, revisedOfferCents: 31000 })).toBe(31000);
  });

  it("falls back to what was actually paid", () => {
    expect(agreedCents({ estimateCents: 40000, payout: { amountCents: 38000 } })).toBe(38000);
  });

  it("treats the quote as agreed when nothing changed it", () => {
    expect(agreedCents({ estimateCents: 40000 })).toBe(40000);
  });
});

describe("spotting a revised offer", () => {
  it("reads one off the amount", () => {
    expect(hadRevisedOffer({ revisedOfferCents: 31000 })).toBe(true);
  });

  it("reads one off the timeline when the amount is gone", () => {
    // A declined offer leaves no agreed amount behind, and it still happened.
    expect(hadRevisedOffer({ timeline: [{ event: "revised_offer_sent" }] })).toBe(true);
  });

  it("does not invent one", () => {
    expect(hadRevisedOffer({ estimateCents: 40000, timeline: [] })).toBe(false);
  });
});

describe("the headline numbers", () => {
  it("counts what happened", () => {
    const metrics = buildTradeInMetrics({
      requests: [
        paidAfter(4),
        request({ status: "Expired" }),
        request({ status: "Rejected" }),
        request({ status: "InTransit" }),
      ],
    });

    expect(metrics).toMatchObject({ total: 4, paid: 1, expired: 1, rejected: 1, concluded: 3 });
  });

  it("measures acceptance against what concluded, not against everything", () => {
    // A quote sent yesterday has not failed to be accepted; it simply has not
    // been answered. Counting it would flatter nothing and spoil everything.
    const metrics = buildTradeInMetrics({
      requests: [paidAfter(3), request({ status: "Expired" }), request({ status: "Quoted" })],
    });

    expect(metrics.concluded).toBe(2);
    expect(metrics.acceptanceRate).toBe(50);
  });

  it("says nothing rather than zero when there is nothing to divide by", () => {
    // Reporting a 0% acceptance rate for a month with no trade-ins would read
    // as a disaster.
    const metrics = buildTradeInMetrics({ requests: [] });

    expect(metrics.acceptanceRate).toBeNull();
    expect(metrics.expiredRate).toBeNull();
    expect(metrics.avgDeductionPercent).toBeNull();
  });

  it("averages the deduction over revised offers only", () => {
    // Forty untouched quotes and one halved offer reads as a 1% average
    // deduction, which says nothing about what happens when a device is worse
    // than described.
    const metrics = buildTradeInMetrics({
      requests: [
        paidAfter(2, { estimateCents: 40000, revisedOfferCents: 20000 }),
        paidAfter(2),
        paidAfter(2),
      ],
    });

    expect(metrics.revisedOffers).toBe(1);
    expect(metrics.avgDeductionPercent).toBe(50);
  });

  it("averages the days to payment over paid trade-ins only", () => {
    // The others have no end date, and averaging over a null is how a mean
    // silently becomes a mean of the fast ones.
    const metrics = buildTradeInMetrics({
      requests: [paidAfter(2), paidAfter(6), request({ status: "Expired" })],
    });

    expect(metrics.avgDaysToPaid).toBe(4);
  });

  it("does not count a paid trade-in with no payment date", () => {
    const metrics = buildTradeInMetrics({
      requests: [paidAfter(4), request({ status: "Paid", payout: {} })],
    });

    expect(metrics.avgDaysToPaid).toBe(4);
  });

  it("adds up what actually went out, not what was quoted", () => {
    // The recorded payment is the truth. A quote is what UpCell offered, and
    // a report of money paid that adds up offers is a report of nothing.
    const metrics = buildTradeInMetrics({
      requests: [
        paidAfter(1, { estimateCents: 40000, payout: { paidAt: CREATED, amountCents: 31000 } }),
        paidAfter(1, { estimateCents: 40000, payout: { paidAt: CREATED, amountCents: 20000 } }),
      ],
    });

    expect(metrics.paidOutCents).toBe(51000);
  });

  it("prefers the recorded payment over the revised offer", () => {
    // They should agree. Where they do not, the money that left the bank is
    // the one a report has to add up.
    expect(agreedCents({
      estimateCents: 40000,
      revisedOfferCents: 31000,
      payout: { amountCents: 30000 },
    })).toBe(31000);
  });

  it("counts a trade-in as paid when it carries a payment, whatever its status", () => {
    // Closed after being paid is still a trade-in that was paid.
    const metrics = buildTradeInMetrics({
      requests: [request({ status: "Closed", payout: { paidAt: CREATED, amountCents: 40000 } })],
    });

    expect(metrics.paid).toBe(1);
  });
});

describe("by model", () => {
  it("finds the model that keeps being re-quoted", () => {
    // Three in four ending in a revised offer is a price book entry that is
    // wrong, or a condition question customers read differently.
    const rows = groupTradeIns([
      paidAfter(2, { modelTitle: "iPhone 11 64GB", estimateCents: 20000, revisedOfferCents: 12000 }),
      paidAfter(2, { modelTitle: "iPhone 11 64GB", estimateCents: 20000, revisedOfferCents: 14000 }),
      paidAfter(2, { modelTitle: "iPhone 13 128GB" }),
    ]);

    const eleven = rows.find((row) => row.name === "iPhone 11 64GB");
    expect(eleven.quoted).toBe(2);
    expect(eleven.revisedOffers).toBe(2);
    expect(eleven.avgDeductionPercent).toBe(35);
  });

  it("puts the most-quoted model first", () => {
    // The models UpCell sees most are where a wrong price costs the most.
    const rows = groupTradeIns([
      request({ modelTitle: "Rare" }),
      request({ modelTitle: "Common" }),
      request({ modelTitle: "Common" }),
    ]);

    expect(rows[0].name).toBe("Common");
  });

  it("groups a request with no model under Unknown rather than dropping it", () => {
    const rows = groupTradeIns([request({ modelTitle: undefined })]);

    expect(rows[0].name).toBe("Unknown");
  });

  it("gives back nothing for nothing", () => {
    expect(groupTradeIns([])).toEqual([]);
  });
});
