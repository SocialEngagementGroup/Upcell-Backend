// Converts the legacy Stripe-shaped line_items array into the flat, typed
// shape the order model is migrating to. Pure and framework-free on purpose:
// this exact function is shared by the checkout path (new orders) and the
// one-off migration script (existing orders), so there is only ever one
// definition of "how a line_item becomes an item" to keep correct.
//
// The legacy shape mixes two different kinds of things in one array: a real
// product line (has metadata.productId, carries description/images) and a
// fee line (tax or shipping — no productId, no description). This function
// is what used to be scattered across orderTotal(), refund.js's
// isRefundableLine(), and reconciliation.js as ad-hoc "does it have a
// productId" checks; now it happens once, here.
//
// totalPaid (dollars) is treated as the ground truth for every line, not
// unit_amount (cents) — totalPaid is what receipts, refunds, and the bank
// verification have always actually used. unitPriceCents/lineTotalCents are
// both derived from it, so the two money fields a legacy line_item carried
// can never disagree in the new shape the way they could in the old one.
const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);

const TAX_LINE_NAME = "Sales tax";

function convertLineItems(lineItems) {
  const items = [];
  let taxCents = 0;
  let shippingCents = 0;
  const unrecognized = [];

  for (const line of lineItems || []) {
    const productData = line?.price_data?.product_data;
    const metadata = productData?.metadata || {};
    const lineTotalCents = toCents(metadata.totalPaid);

    if (metadata.productId) {
      const quantity = line.quantity || metadata.quantity || 1;
      items.push({
        productId: metadata.productId,
        name: productData?.name || "Item",
        description: productData?.description || undefined,
        image: productData?.images?.[0] || undefined,
        quantity,
        unitPriceCents: Math.round(lineTotalCents / quantity),
        lineTotalCents,
      });
      continue;
    }

    const name = productData?.name || "";
    if (name === TAX_LINE_NAME) {
      taxCents += lineTotalCents;
    } else if (/shipping/i.test(name)) {
      shippingCents += lineTotalCents;
    } else {
      // A line that is neither a recognised product nor a recognised fee.
      // Never silently fold this into shipping or tax and quietly misreport
      // what the customer was charged for — surface it instead.
      unrecognized.push({ name, lineTotalCents });
    }
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const totalCents = subtotalCents + taxCents + shippingCents;

  return { items, taxCents, shippingCents, subtotalCents, totalCents, unrecognized };
}

module.exports = { convertLineItems, toCents };
