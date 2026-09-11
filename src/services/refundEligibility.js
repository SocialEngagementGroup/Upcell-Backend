// Whether an order can be returned at all, and which of its items. Kept apart
// from the controller so the rules can be tested against dates and orders
// without a database, the same way refund.js is.
//
// Thirty days for every reason. Where those thirty days start is the part with
// any judgement in it, and that lives in services/returnWindow.js — delivery
// date where the carrier recorded one, ship date plus three where it did not,
// and a dated staff override with a note where a person had to decide.
const { isRefundableLine } = require("./refund");
const {
  RETURN_WINDOW_DAYS,
  resolveWindowStart,
  transitClaimInTime,
} = require("./returnWindow");
const { claimKind, checkWarrantyReason, WARRANTY_REASON_CODES } = require("./warranty");

// Reasons that are a claim about the journey rather than about the device.
// These have their own, much shorter deadline: after a few days nobody can
// tell a courier's dent from a kitchen-counter dent.
const TRANSIT_DAMAGE_REASONS = ["ARRIVED_DAMAGED_BOX", "PHYSICAL_DAMAGE_ON_ARRIVAL"];

/**
 * The last moment a customer can ask to return this order.
 *
 * Returns null when the window has not started — the order has neither been
 * delivered nor shipped. That is not the same as expired: the customer has
 * done nothing wrong and simply has to wait.
 */
function returnWindowClosesAt(order, reasonCode, options = {}) {
  const window = resolveWindowStart(order, options);
  return window ? window.expiresAt : null;
}

/**
 * Can this order be returned, and if not, why not.
 *
 * The reasons are written to be shown to the customer as they are. A refusal
 * that only says "not eligible" sends them to support to find out why, which
 * costs staff time for something the system already knows.
 *
 * @returns {{ok: true, closesAt: Date, items: object[]}
 *          | {ok: false, reason: string, message: string}}
 */
function checkReturnEligibility(order, { now = new Date(), reasonCode, override } = {}) {
  if (!order) {
    return { ok: false, reason: "not_found", message: "Order not found." };
  }

  if (!order.paid) {
    return {
      ok: false,
      reason: "not_paid",
      message: "This order has not been paid, so there is nothing to return.",
    };
  }

  if (order.refund?.approvedAt) {
    return {
      ok: false,
      reason: "already_refunded",
      message: "This order has already been refunded.",
    };
  }

  const windowDays = RETURN_WINDOW_DAYS;
  const window = resolveWindowStart(order, { override });

  // Neither delivered nor shipped. The window has not opened yet, which is a
  // different answer from having missed it.
  if (!window) {
    return {
      ok: false,
      reason: "not_delivered",
      message:
        `This order has not been delivered yet. The ${windowDays}-day return window starts on the day it arrives.`,
    };
  }

  const closesAt = window.expiresAt;

  // Past 30 days is not automatically a no. The first year is covered by the
  // warranty, and a device that is broken in month eight is a claim UpCell
  // advertises it will honour — just not one that ends in a refund.
  const { kind, warrantyEndsAt } = claimKind(order, { now, override });

  if (kind === "EXPIRED") {
    return {
      ok: false,
      reason: "window_closed",
      message:
        `The ${windowDays}-day return window for this order closed on ${closesAt.toDateString()}, ` +
        `and the 12-month warranty ended on ${warrantyEndsAt.toDateString()}.`,
      closesAt,
      warrantyEndsAt,
    };
  }

  // Only once a reason has actually been chosen. This same function answers
  // the page load, which happens before the customer has picked anything, and
  // refusing there would show "choose a fault" as an error above a form they
  // have not been given yet. Submitting without one is refused by the
  // controller, which is where the requirement belongs.
  if (kind === "WARRANTY" && reasonCode) {
    const allowed = checkWarrantyReason(reasonCode, { closesAt, warrantyEndsAt });
    if (!allowed.ok) {
      return { ok: false, reason: allowed.reason, message: allowed.message, closesAt, warrantyEndsAt };
    }
  }

  // Damage in transit is a claim about the journey, and it has a much shorter
  // deadline than the device itself does.
  if (kind === "RETURN" && TRANSIT_DAMAGE_REASONS.includes(reasonCode)) {
    const claim = transitClaimInTime(order, { now });
    if (!claim.ok) {
      return {
        ok: false,
        reason: "transit_claim_late",
        message: claim.message,
        closesAt,
      };
    }
  }

  // Tax and shipping lines carry no productId — only real devices and
  // accessories do, which is the same test the refund calculation uses.
  const items = (order.line_items || []).filter(isRefundableLine);
  if (!items.length) {
    return {
      ok: false,
      reason: "nothing_returnable",
      message: "This order has no returnable items.",
    };
  }

  return {
    ok: true,
    // RETURN or WARRANTY. The caller shows different words, offers different
    // reasons and pays a different amount, and this is the one place that
    // decides which.
    kind,
    closesAt,
    warrantyEndsAt,
    // Only the hardware faults, once the 30 days are up. Sent so the form can
    // draw the shorter list rather than offering a customer a reason the
    // server will then refuse.
    reasonCodes: kind === "WARRANTY" ? WARRANTY_REASON_CODES : null,
    windowDays,
    // Where the clock started, so the queue can show it and staff can see
    // when it was estimated rather than recorded.
    startedFrom: window.startedFrom,
    startDate: window.startDate,
    items,
  };
}

/**
 * Whether the productIds a customer selected are actually on this order.
 *
 * Without this an ObjectId from someone else's order, or one simply invented,
 * would be accepted and later refunded against — calculateRefund would find no
 * matching line and quietly refund nothing, which reads as a system fault
 * rather than a bad request.
 */
function checkSelectedItems(order, itemIds) {
  const selected = [...new Set((itemIds || []).map(String))];

  if (!selected.length) {
    return { ok: false, message: "Choose at least one item to return." };
  }

  const onOrder = new Set(
    (order.line_items || [])
      .filter(isRefundableLine)
      .map((item) => String(item.price_data.product_data.metadata.productId))
  );

  const strangers = selected.filter((id) => !onOrder.has(id));
  if (strangers.length) {
    return { ok: false, message: "One of the items chosen is not on this order." };
  }

  return { ok: true, itemIds: selected };
}

module.exports = {
  RETURN_WINDOW_DAYS,
  returnWindowClosesAt,
  checkReturnEligibility,
  checkSelectedItems,
};
