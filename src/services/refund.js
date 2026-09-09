// Refund math, isolated from the controller so it can be tested against real
// numbers without a database. UpCell has no refund API credentials — this
// never moves money. It calculates the figure a staff member types into the
// Bank of America Business Center by hand.
//
// The rule below is exactly what the client confirmed, no more:
//   refund = (price of the returned items) − 15% restocking fee (unless waived)
//            + the sales tax charged on those items
//   shipping is never refunded
//
// Tax was left out of this calculation until 9 September 2026, because the
// client's own worked example predated UpCell charging tax at all and never
// mentioned it. They have now confirmed it: the 8% comes back in full, and the
// 15% fee is taken on the goods only, never on the tax. Shipping is unchanged —
// on a partial return UpCell bears that cost itself rather than refunding it.

const { round2 } = require("../utils/money");

const RESTOCKING_FEE_RATE = 0.15;

// Tax and shipping lines carry no productId — only real devices and
// accessories do. This is the same test checkout.controller.js uses to tell
// them apart when reading an order back apart.
const isRefundableLine = (item) => Boolean(item?.price_data?.product_data?.metadata?.productId);

// The one non-product line the customer is owed back. Matched by the name
// checkout.controller.js writes, because that is the only thing distinguishing
// it from the shipping line — both carry a totalPaid and no productId, and
// only one of them is refundable. Shipping is deliberately not matched.
const isTaxLine = (item) =>
  !isRefundableLine(item) &&
  String(item?.price_data?.product_data?.name || "").trim().toLowerCase() === "sales tax";

const totalPaidOf = (items) =>
  round2(items.reduce((sum, item) => sum + (item?.price_data?.product_data?.metadata?.totalPaid || 0), 0));

/**
 * What refunding some or all of an order's items comes to.
 *
 * @param {object} order            the order document (or a plain object with line_items)
 * @param {object} options
 * @param {string[]} [options.itemIds]      productIds to refund; omitted or empty means every item
 * @param {boolean} [options.waiveRestockingFee]
 * @param {string}  [options.waiveReason]   required when waiving the fee
 * @returns {{ok: true, refundableItems, itemsTotal, restockingFee, restockingFeeWaived, taxRefunded, refundAmount}
 *          | {ok: false, error: string}}
 */
function calculateRefund(order, { itemIds, waiveRestockingFee = false, waiveReason } = {}) {
  const lines = order?.line_items || [];
  const productLines = lines.filter(isRefundableLine);

  const requested = itemIds && itemIds.length ? new Set(itemIds.map(String)) : null;

  const refundableItems = requested
    ? productLines.filter((item) =>
        requested.has(String(item.price_data.product_data.metadata.productId))
      )
    : productLines;

  if (!refundableItems.length) {
    return { ok: false, error: "No matching items on this order." };
  }

  if (waiveRestockingFee && !String(waiveReason || "").trim()) {
    return { ok: false, error: "A reason is required to waive the restocking fee." };
  }

  const itemsTotal = totalPaidOf(refundableItems);

  const restockingFee = waiveRestockingFee ? 0 : round2(itemsTotal * RESTOCKING_FEE_RATE);

  // Tax is shared out by what the returned items cost, not recalculated as 8%
  // of them. Two reasons: a full return then hands back exactly the figure that
  // was charged, cent for cent, rather than a freshly rounded approximation of
  // it; and an order placed before UpCell charged tax has no tax line to share
  // out, so it correctly returns nothing instead of inventing 8% the customer
  // never paid.
  const goodsTotal = totalPaidOf(productLines);
  const taxPaid = totalPaidOf(lines.filter(isTaxLine));
  const taxRefunded = goodsTotal > 0 ? round2(taxPaid * (itemsTotal / goodsTotal)) : 0;

  const refundAmount = round2(itemsTotal - restockingFee + taxRefunded);

  return {
    ok: true,
    refundableItems,
    itemsTotal,
    restockingFee,
    restockingFeeWaived: Boolean(waiveRestockingFee),
    taxRefunded,
    refundAmount,
  };
}

module.exports = { calculateRefund, RESTOCKING_FEE_RATE, isRefundableLine, isTaxLine };
