// What the trade-in data says.
//
// The questions are the mirror of the returns ones. Returns ask which model
// keeps coming back; trade-ins ask which model UpCell keeps quoting too high
// for. A model where the revised offer is routinely 30% under the quote is a
// price book entry that is wrong, or a set of condition questions customers
// are reading differently from the way they were meant.
//
// Computed from plain arrays rather than in an aggregation pipeline, for the
// reasons returnReporting.js gives: they can be tested against handmade data
// with no database, and the rate denominators — the easiest thing in
// reporting to get quietly wrong — stay readable.

const { toCsv } = require("./returnReporting");

const round1 = (value) => Math.round(value * 10) / 10;

// A rate with no denominator is not zero, it is unknown. Reporting a 0%
// acceptance rate for a month with no trade-ins would read as a disaster.
const rate = (numerator, denominator) =>
  denominator > 0 ? round1((numerator / denominator) * 100) : null;

const average = (values) =>
  values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

const DAY_MS = 24 * 60 * 60 * 1000;

// A trade-in that reached a conclusion. One still in the post is not evidence
// of anything yet, and counting it as "not expired" flatters the numbers.
const SETTLED_STATUSES = ["Paid", "Closed"];
const CONCLUDED_STATUSES = [...SETTLED_STATUSES, "Rejected", "ReturnShipped", "Expired", "Cancelled"];

const isConcluded = (request) => CONCLUDED_STATUSES.includes(request.status);

/**
 * What was quoted, in cents, from whichever field the record has.
 *
 * Older requests stored dollars. Reading them as cents would report a $400
 * quote as $4, which is the kind of number somebody acts on.
 */
function quotedCents(request) {
  if (Number.isFinite(request?.estimateCents)) return request.estimateCents;
  if (Number.isFinite(request?.estimate)) return Math.round(request.estimate * 100);
  return null;
}

/**
 * What was actually agreed, in cents. The revised offer where there was one.
 */
function agreedCents(request) {
  if (Number.isFinite(request?.revisedOfferCents)) return request.revisedOfferCents;
  if (Number.isFinite(request?.payout?.amountCents)) return request.payout.amountCents;
  return quotedCents(request);
}

const hadRevisedOffer = (request) =>
  Number.isFinite(request?.revisedOfferCents) ||
  (request?.timeline || []).some((entry) => entry?.event === "revised_offer_sent");

/**
 * Every headline number, from a list of trade-in requests.
 *
 * @param {object[]} requests  trade-ins created inside the period
 */
function buildTradeInMetrics({ requests = [] } = {}) {
  const concluded = requests.filter(isConcluded);
  const paid = requests.filter((request) => request.status === "Paid" || request.payout?.paidAt);
  const expired = requests.filter((request) => request.status === "Expired");
  const rejected = requests.filter((request) => request.status === "Rejected");

  // Deductions, only where an offer was actually revised.
  //
  // Averaging over every trade-in would bury the number: forty untouched
  // quotes and one halved offer reads as a 1% average deduction, which says
  // nothing about what happens when a device is worse than described.
  const revised = requests.filter(hadRevisedOffer);
  const deductions = revised
    .map((request) => {
      const quoted = quotedCents(request);
      const agreed = agreedCents(request);
      if (!Number.isFinite(quoted) || !Number.isFinite(agreed) || quoted <= 0) return null;
      return ((quoted - agreed) / quoted) * 100;
    })
    .filter((value) => value != null);

  // Quote to money, in days. Only for trade-ins that were actually paid —
  // the others have no end date and averaging over a null is how a mean
  // silently becomes a mean of the fast ones.
  const settlementDays = paid
    .map((request) => {
      const start = request.createdAt;
      const end = request.payout?.paidAt;
      if (!start || !end) return null;
      return (new Date(end).getTime() - new Date(start).getTime()) / DAY_MS;
    })
    .filter((value) => value != null && value >= 0);

  return {
    total: requests.length,
    concluded: concluded.length,
    paid: paid.length,
    rejected: rejected.length,
    expired: expired.length,
    revisedOffers: revised.length,

    // Of the trade-ins that reached a conclusion, how many ended in money.
    // Denominator is concluded, not total: a quote sent yesterday has not
    // failed to be accepted, it simply has not been answered.
    acceptanceRate: rate(paid.length, concluded.length),
    // How often a quote runs out before a device arrives. A climbing number
    // here is a price that stopped being attractive, or a label nobody sent.
    expiredRate: rate(expired.length, concluded.length),
    rejectedRate: rate(rejected.length, concluded.length),
    // How often a device is worse than the customer said.
    revisedRate: rate(revised.length, concluded.length),

    // The average cut, as a percentage of the quote, across the offers that
    // were actually revised.
    avgDeductionPercent: average(deductions),
    avgDaysToPaid: average(settlementDays),

    paidOutCents: paid.reduce((sum, request) => sum + (agreedCents(request) || 0), 0),
  };
}

/**
 * The same numbers broken down by model.
 *
 * This is the one that finds a wrong price. A model quoted forty times where
 * three in four end in a revised offer is a price book entry that is wrong,
 * or a condition question customers are reading differently from the way it
 * was meant.
 */
function groupTradeIns(requests = [], field = "modelTitle") {
  const groups = new Map();

  requests.forEach((request) => {
    const key = request?.[field] || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  });

  return [...groups.entries()]
    .map(([name, rows]) => {
      const metrics = buildTradeInMetrics({ requests: rows });
      return {
        name,
        quoted: rows.length,
        paid: metrics.paid,
        expired: metrics.expired,
        rejected: metrics.rejected,
        revisedOffers: metrics.revisedOffers,
        acceptanceRate: metrics.acceptanceRate,
        avgDeductionPercent: metrics.avgDeductionPercent,
        paidOutCents: metrics.paidOutCents,
      };
    })
    // Most quoted first. The models UpCell sees most are the ones where a
    // wrong price costs the most.
    .sort((a, b) => b.quoted - a.quoted || a.name.localeCompare(b.name));
}

module.exports = {
  buildTradeInMetrics,
  groupTradeIns,
  quotedCents,
  agreedCents,
  hadRevisedOffer,
  toCsv,
  CONCLUDED_STATUSES,
  SETTLED_STATUSES,
};
