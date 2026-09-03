const SingleVariation = require("../models/singleVariation.model");

// Every device UpCell sells is one physical unit. Two customers reaching
// checkout at the same moment could both be authorised for the same phone, and
// one of them would then have to be refunded by hand — which, with partial
// refunds not yet enabled on the merchant account, is a problem with no clean
// resolution. Holding the device for the customer who got there first is what
// prevents that.
//
// Checking "is it in stock?" and then creating the order is two steps, and two
// requests can both pass the check before either writes. The claim below is a
// single findOneAndUpdate: the filter and the write happen together, so exactly
// one of them can win.

// Long enough to enter card details on the bank's page without being rushed,
// short enough that an abandoned checkout returns the device to sale the same
// afternoon. It is only a floor — a confirmed decline releases immediately.
const HOLD_MS = 20 * 60 * 1000;

// How long a device stays held while the bank reviews the payment by hand.
// Long enough that a review spanning a weekend does not quietly release the
// device; short enough that a hold nobody ever resolves cannot outlive the
// order. The daily reconciliation report is what makes this safe — see
// holdForReview below.
const REVIEW_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

const isAvailableFilter = (holder, now) => ({
  outOfStock: { $ne: true },
  $or: [
    { reservedUntil: null },
    { reservedUntil: { $lt: now } },
    // Our own earlier attempt. A customer who reloads the checkout page must
    // not be blocked by the reservation they themselves are holding.
    { reservedFor: holder },
  ],
});

/**
 * Hold every device in the list for one checkout.
 *
 * All or nothing: if any single device is gone, the ones already taken are put
 * back before returning. A partly-reserved cart would either charge for items
 * the customer cannot receive, or quietly drop items they chose to buy.
 *
 * @param {string[]} ids     variation ids, deduplicated by the caller
 * @param {string} holder    the checkout's boaTransactionUuid
 * @returns {Promise<{ok: boolean, unavailable: Array<{id: string, name?: string}>}>}
 */
async function reserveVariations(ids, holder) {
  const now = new Date();
  const until = new Date(now.getTime() + HOLD_MS);
  const taken = [];

  // Accessories are stocked in quantity, not one at a time. Holding a case for
  // one customer would stop everyone else buying one, and marking it sold after
  // the first order would take it off sale entirely.
  const stockable = await SingleVariation.find({
    _id: { $in: ids },
    isAccessory: { $ne: true },
  })
    .select("_id")
    .lean();

  const heldIds = new Set(stockable.map((item) => String(item._id)));

  for (const id of ids.filter((id) => heldIds.has(String(id)))) {
    const claimed = await SingleVariation.findOneAndUpdate(
      { _id: id, ...isAvailableFilter(holder, now) },
      { $set: { reservedUntil: until, reservedFor: holder } },
      { new: true }
    ).lean();

    if (claimed) {
      taken.push(id);
      continue;
    }

    // Lost the race, or already sold. Put back whatever we took first.
    if (taken.length) await releaseReservation(holder);

    const item = await SingleVariation.findById(id).select("productName").lean();
    return {
      ok: false,
      unavailable: [
        {
          id,
          name: item?.productName,
          message: item?.productName
            ? `${item.productName} has just been bought by someone else.`
            : "An item in your cart is no longer available.",
        },
      ],
    };
  }

  return { ok: true, unavailable: [] };
}

/**
 * Put back everything a checkout was holding. Safe to call more than once, and
 * safe to call for a checkout that reserved nothing.
 */
async function releaseReservation(holder) {
  if (!holder) return 0;

  const result = await SingleVariation.updateMany(
    { reservedFor: holder },
    { $set: { reservedUntil: null, reservedFor: null } }
  );

  return result.modifiedCount || 0;
}

/**
 * Keep holding the devices while the bank decides.
 *
 * A REVIEW decision means a person at the bank is looking at the payment. That
 * takes hours or days, and the ordinary hold lasts twenty minutes — so simply
 * not releasing it is not enough: it expires on its own and the device goes
 * back on sale while the customer may still be charged for it.
 *
 * Extending is the honest position. The device is genuinely committed to this
 * customer until the bank says otherwise, and selling it to someone else in the
 * meantime creates exactly the double-sale this whole service exists to stop.
 * The reconciliation report names these every day so a hold cannot sit
 * forgotten, which is what stops the extension quietly costing us sales.
 */
async function holdForReview(holder) {
  if (!holder) return 0;

  const until = new Date(Date.now() + REVIEW_HOLD_MS);

  const result = await SingleVariation.updateMany(
    { reservedFor: holder },
    { $set: { reservedUntil: until } }
  );

  return result.modifiedCount || 0;
}

/**
 * Take the devices off sale for good, once the money is confirmed.
 *
 * Nothing did this before: outOfStock could only be set by hand in the admin
 * panel, so every sale relied on someone remembering to switch that device off
 * afterwards. Anything missed stayed on sale and could be sold twice.
 */
async function markSold(ids) {
  if (!ids?.length) return 0;

  const result = await SingleVariation.updateMany(
    // Devices only. Selling one case must not take cases off the shop.
    { _id: { $in: ids }, isAccessory: { $ne: true } },
    { $set: { outOfStock: true, reservedUntil: null, reservedFor: null } }
  );

  return result.modifiedCount || 0;
}

/** The variation ids inside an order's line items, skipping shipping lines. */
const variationIdsFromOrder = (order) =>
  (order?.line_items || [])
    .map((item) => item?.price_data?.product_data?.metadata?.productId)
    .filter(Boolean)
    .map(String);

module.exports = {
  reserveVariations,
  releaseReservation,
  holdForReview,
  markSold,
  variationIdsFromOrder,
  HOLD_MS,
  REVIEW_HOLD_MS,
};
