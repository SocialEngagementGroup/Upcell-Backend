// What the returns data says.
//
// The point of measuring returns is to find the bad batch before it becomes
// fifty returns: a model that comes back twice as often as the rest, a reason
// code climbing month on month, a supplier whose devices fail inspection. None
// of that is visible one request at a time.
//
// The metrics are computed from plain arrays rather than in an aggregation
// pipeline. Two reasons: they can be tested against handmade data with no
// database, and the arithmetic — especially the rate denominators, which are
// the easiest thing in reporting to get quietly wrong — stays readable.

const { PHOTO_HOLD_STATUSES } = require("../constants/returnStatus");
const { reasonCategory } = require("../constants/returnReasons");

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

// A rate with no denominator is not zero, it is unknown. Reporting 0% return
// rate for a month with no sales would read as a triumph.
const rate = (numerator, denominator) =>
  denominator > 0 ? round1((numerator / denominator) * 100) : null;

const countBy = (rows, pick) => {
  const counts = {};
  for (const row of rows) {
    const key = pick(row);
    if (key == null) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

// Returns that reached a conclusion. A return still in the post is not evidence
// of anything yet, and counting it as "not rejected" flatters the reject rate.
const SETTLED_STATUSES = ["Refunded", "Closed"];
const CONCLUDED_STATUSES = [...SETTLED_STATUSES, "Rejected", "ReturnShipped", "Expired", "Cancelled"];

const isConcluded = (request) => CONCLUDED_STATUSES.includes(request.status);

/**
 * Every headline number, from a list of returns and how many units were sold.
 *
 * @param {object[]} requests   returns created inside the period
 * @param {number} unitsSold    units sold in the same period, for the rate
 */
function buildReturnMetrics({ requests = [], unitsSold = 0 } = {}) {
  const concluded = requests.filter(isConcluded);

  // Reject rate is measured against returns that concluded, not against every
  // return ever opened — otherwise a busy month of in-flight returns makes the
  // reject rate look like it fell.
  const rejected = concluded.filter((request) =>
    ["Rejected", "ReturnShipped"].includes(request.status)
  );

  const settled = requests.filter((request) => request.resolution?.settledAt);

  const daysToSettle = settled
    .map((request) => {
      const from = request.createdAt;
      const to = request.resolution.settledAt;
      if (!from || !to) return null;
      return (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
    })
    .filter((days) => days != null);

  // Only returns that were actually given a deadline can breach one.
  const withDeadline = requests.filter((request) => request.sla?.dueAt);
  const breached = withDeadline.filter((request) => {
    const settledAt = request.resolution?.settledAt;
    // Not settled yet: late only if the deadline has already passed.
    if (!settledAt) return new Date(request.sla.dueAt).getTime() < Date.now();
    return new Date(settledAt).getTime() > new Date(request.sla.dueAt).getTime();
  });

  const offered = requests.filter((request) =>
    (request.timeline || []).some((entry) => entry.event === "revised_offer_sent")
  );
  const offersAccepted = offered.filter((request) =>
    (request.timeline || []).some((entry) => entry.event === "revised_offer_accepted")
  );

  const recoveredValue = requests
    .filter((request) => request.disposition?.type)
    .reduce((sum, request) => sum + (request.refundBreakdown?.orderAmount || 0), 0);

  return {
    total: requests.length,
    unitsSold,
    // Null rather than 0 when nothing was sold — see `rate`.
    returnRate: rate(requests.length, unitsSold),

    byReason: countBy(requests, (request) => request.reasonCode),
    byCategory: countBy(requests, (request) =>
      request.reasonCategory || (request.reasonCode ? reasonCategory(request.reasonCode) : null)
    ),
    byAttribution: countBy(requests, (request) => request.faultAttribution),
    byStatus: countBy(requests, (request) => request.status),
    byDisposition: countBy(requests, (request) => request.disposition?.type),

    concluded: concluded.length,
    rejectRate: rate(rejected.length, concluded.length),

    settledCount: settled.length,
    averageDaysToSettle: daysToSettle.length
      ? round1(daysToSettle.reduce((sum, days) => sum + days, 0) / daysToSettle.length)
      : null,

    slaBreachRate: rate(breached.length, withDeadline.length),
    slaBreaches: breached.length,

    revisedOffersSent: offered.length,
    revisedOfferAcceptanceRate: rate(offersAccepted.length, offered.length),

    // The value of devices that got a route, which is the closest thing to
    // "what did we get back" without a per-device valuation UpCell does not
    // have yet. Named for what it actually is rather than implying resale
    // proceeds.
    dispositionedValue: round2(recoveredValue),
    // Photos still held because a case is open, so the retention policy can be
    // reported on rather than assumed.
    underDisputeHold: requests.filter((request) => PHOTO_HOLD_STATUSES.includes(request.status)).length,
  };
}

/**
 * The same returns, grouped by whichever field is being investigated.
 *
 * Sorted by count so the worst offender is first — the whole reason to look at
 * this is to find the model or reason that stands out.
 */
function groupReturns(requests = [], field = "productName") {
  const groups = new Map();

  for (const request of requests) {
    const key = String(request[field] ?? request.device?.[field] ?? "Unknown");
    const group = groups.get(key) || { key, total: 0, rejected: 0, reasons: {} };

    group.total += 1;
    if (["Rejected", "ReturnShipped"].includes(request.status)) group.rejected += 1;
    if (request.reasonCode) {
      group.reasons[request.reasonCode] = (group.reasons[request.reasonCode] || 0) + 1;
    }

    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => right.total - left.total);
}

// CSV, quoted properly.
//
// Written here rather than pulled in as a dependency because the only hard part
// is escaping, and getting that wrong corrupts a spreadsheet silently: a
// product name with a comma in it shifts every column after it by one.
function toCsv(rows = [], columns) {
  if (!rows.length) return "";

  const keys = columns || Object.keys(rows[0]);

  const escape = (value) => {
    if (value == null) return "";
    const text = String(value);
    // A field is quoted whenever it contains the separator, a quote, or a
    // newline. Quotes inside are doubled, which is what every spreadsheet
    // expects.
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    keys.join(","),
    ...rows.map((row) => keys.map((key) => escape(row[key])).join(",")),
  ].join("\n");
}

module.exports = {
  buildReturnMetrics,
  groupReturns,
  toCsv,
  CONCLUDED_STATUSES,
  SETTLED_STATUSES,
};
