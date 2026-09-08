// Whether an order can be returned at all, and which of its items. Kept apart
// from the controller so the rules can be tested against dates and orders
// without a database, the same way refund.js is.
//
// The rules are the client's, confirmed: 30 days, counted from delivery.
const { isRefundableLine } = require("./refund");

const RETURN_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last moment a customer can ask to return this order.
 *
 * Counted from deliveredAt, not createdAt. An order placed on the 1st and
 * delivered on the 10th gives the customer until the 9th of the next month —
 * counting from the order date would quietly eat nine days of their window.
 *
 * Returns null when the order has not been delivered, which is not the same as
 * "expired": the window has not started yet.
 */
function returnWindowClosesAt(order) {
  if (!order?.deliveredAt) return null;
  return new Date(new Date(order.deliveredAt).getTime() + RETURN_WINDOW_DAYS * DAY_MS);
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
function checkReturnEligibility(order, { now = new Date() } = {}) {
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

  // Not delivered yet. Deliberately separate from an expired window: the
  // customer has done nothing wrong and simply has to wait.
  if (!order.deliveredAt) {
    return {
      ok: false,
      reason: "not_delivered",
      message:
        "This order has not been delivered yet. The 30-day return window starts on the day it arrives.",
    };
  }

  const closesAt = returnWindowClosesAt(order);
  if (now > closesAt) {
    return {
      ok: false,
      reason: "window_closed",
      message: `The 30-day return window for this order closed on ${closesAt.toDateString()}.`,
    };
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

  return { ok: true, closesAt, items };
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
