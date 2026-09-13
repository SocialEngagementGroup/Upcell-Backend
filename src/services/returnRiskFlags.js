// What a staff member needs to notice before approving a return.
//
// The point of the approval queue is that approving is one click. That only
// works if the things worth a second look are already on the row — otherwise
// every request needs the same manual checking the queue was meant to remove,
// and the checks get skipped on a busy day rather than done badly.
//
// None of these block anything. A flag is a reason to look, never a refusal:
// staff approve returns outside the window all the time, and should.
const { returnWindowDays, faultAttributionFor, reasonCategory } = require("../constants/returnReasons");

const DAY_MS = 24 * 60 * 60 * 1000;

// Above this, a wrong decision costs enough to be worth a second pair of eyes.
// A starting value, not a researched one — worth revisiting once there is a
// few months of return history to look at.
const HIGH_VALUE_THRESHOLD = 1000;

// Three in a year is where a pattern stops looking like bad luck. Deliberately
// counted over a rolling year rather than a calendar one, so a customer who
// returns three devices each December is not reset every January.
const REPEAT_RETURN_THRESHOLD = 3;

const daysBetween = (from, to) => Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS);

/**
 * The flags for one request.
 *
 * @param {object} params
 * @param {object} params.request        the ReturnRequest
 * @param {object} params.order          its order, for value and delivery date
 * @param {number} [params.priorReturns] how many returns this customer has had
 *                                       in the last year, not counting this one
 * @param {Date}   [params.now]
 * @returns {{code, severity, message}[]}  severity: "warning" | "info"
 */
function buildReturnFlags({ request, order, priorReturns = 0, now = new Date() }) {
  const flags = [];
  const reasonCode = request?.reasonCode;

  // Asked for after the window closed. Counted from delivery, and the length
  // depends on the reason — 14 days for a change of mind, 30 for a fault.
  if (order?.deliveredAt && reasonCode) {
    const windowDays = returnWindowDays(reasonCode);
    const daysSinceDelivery = daysBetween(order.deliveredAt, new Date(request?.createdAt || now));

    if (daysSinceDelivery > windowDays) {
      flags.push({
        code: "OUTSIDE_WINDOW",
        severity: "warning",
        message: `Asked for ${daysSinceDelivery} days after delivery — the window for this reason is ${windowDays} days.`,
      });
    }
  }

  const orderValue = order?.totalCents != null ? order.totalCents / 100 : null;
  if (orderValue != null && orderValue >= HIGH_VALUE_THRESHOLD) {
    flags.push({
      code: "HIGH_VALUE",
      severity: "warning",
      message: `Order value $${orderValue.toFixed(2)}.`,
    });
  }

  if (priorReturns >= REPEAT_RETURN_THRESHOLD) {
    flags.push({
      code: "REPEAT_RETURNER",
      severity: "warning",
      message: `${priorReturns} previous returns from this customer in the last year.`,
    });
  }

  // The reason implies who is at fault, and that decides who pays the postage
  // and whether the 15% fee applies. If the stored attribution disagrees with
  // the reason, somebody changed one without the other, and the money follows
  // the stored value.
  if (reasonCode) {
    const impliedBy = faultAttributionFor(reasonCode);
    const stored = request?.faultAttribution;

    if (impliedBy && stored && impliedBy !== stored) {
      flags.push({
        code: "ATTRIBUTION_MISMATCH",
        severity: "warning",
        message: `Reason "${reasonCode}" implies ${impliedBy}, but this request is set to ${stored}.`,
      });
    }

    // OTHER cannot decide fault on its own, by design. Somebody has to read the
    // note and say, and until they do the postage and fee are undecided.
    if (!impliedBy && !stored) {
      flags.push({
        code: "ATTRIBUTION_UNDECIDED",
        severity: "warning",
        message: "Reason is OTHER — read the note and set who is at fault before approving.",
      });
    }
  }

  // No structured reason at all. True of every request created before reason
  // codes existed, so it is information rather than a problem.
  if (!reasonCode) {
    flags.push({
      code: "NO_REASON_CODE",
      severity: "info",
      message: "No reason code — this request predates the reason list.",
    });
  }

  return flags;
}

// One row of the approval queue, with the numbers a staff member reads before
// deciding. Kept next to the flags because it is the same question: what does
// this person need to know without opening the request?
function summariseForQueue({ request, order, priorReturns = 0, now = new Date() }) {
  return {
    orderValue: order?.totalCents != null ? order.totalCents / 100 : null,
    daysSinceDelivery: order?.deliveredAt ? daysBetween(order.deliveredAt, now) : null,
    reasonCode: request?.reasonCode || null,
    reasonCategory: request?.reasonCode ? reasonCategory(request.reasonCode) : null,
    faultAttribution: request?.faultAttribution || null,
    priorReturns,
    flags: buildReturnFlags({ request, order, priorReturns, now }),
  };
}

module.exports = {
  buildReturnFlags,
  summariseForQueue,
  HIGH_VALUE_THRESHOLD,
  REPEAT_RETURN_THRESHOLD,
};
