// Refund math, isolated from the controller so it can be tested against real
// numbers without a database. UpCell has no refund API credentials — this
// never moves money. It calculates the figure a staff member types into the
// Bank of America Business Center by hand.
//
// The rule below is exactly what the client confirmed, no more:
//   refund = (price of the returned items) − 15% restocking fee (unless waived)
//   shipping is never refunded
// Their own worked example never mentions tax, so this does not touch it
// either — inventing a tax refund the client never stated would be a second
// undocumented assumption sitting next to the one they already flagged
// (whether partial returns get any shipping back). Both are called out to
// the caller so a human decides, rather than the code deciding quietly.

const RESTOCKING_FEE_RATE = 0.15;

const round2 = (value) => Math.round(value * 100) / 100;

// Tax and shipping lines carry no productId — only real devices and
// accessories do. This is the same test checkout.controller.js uses to tell
// them apart when reading an order back apart.
const isRefundableLine = (item) => Boolean(item?.price_data?.product_data?.metadata?.productId);

/**
 * What refunding some or all of an order's items comes to.
 *
 * @param {object} order            the order document (or a plain object with line_items)
 * @param {object} options
 * @param {string[]} [options.itemIds]      productIds to refund; omitted or empty means every item
 * @param {boolean} [options.waiveRestockingFee]
 * @param {string}  [options.waiveReason]   required when waiving the fee
 * @returns {{ok: true, refundableItems, itemsTotal, restockingFee, restockingFeeWaived, refundAmount}
 *          | {ok: false, error: string}}
 */
function calculateRefund(order, { itemIds, waiveRestockingFee = false, waiveReason } = {}) {
  const productLines = (order?.line_items || []).filter(isRefundableLine);

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

  const itemsTotal = round2(
    refundableItems.reduce(
      (sum, item) => sum + (item.price_data.product_data.metadata.totalPaid || 0),
      0
    )
  );

  const restockingFee = waiveRestockingFee ? 0 : round2(itemsTotal * RESTOCKING_FEE_RATE);
  const refundAmount = round2(itemsTotal - restockingFee);

  return {
    ok: true,
    refundableItems,
    itemsTotal,
    restockingFee,
    restockingFeeWaived: Boolean(waiveRestockingFee),
    refundAmount,
  };
}

module.exports = { calculateRefund, RESTOCKING_FEE_RATE, isRefundableLine };
