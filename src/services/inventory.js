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

// There is deliberately no separate, longer hold for a payment under review.
// A review used to extend the hold to seven days on the reasoning that the
// device was committed to that customer until the bank decided. The rule now
// is the opposite and it is a business decision, not a technical one:
// inventory is never held waiting for a human. One slow review must not take a
// sellable device off the shop for a week.
//
// The cost of that choice is real and is handled rather than hidden — a device
// can sell to somebody else once the twenty minutes are up while a review is
// still open. merchantPost re-checks availability before fulfilling a review
// that later comes back ACCEPT, and raises an oversell_collision when the
// device is gone. See soldAway below.

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
 * Which of these devices have already been sold to somebody else.
 *
 * Only needed because a review no longer holds inventory: between the bank
 * answering REVIEW and a person there answering ACCEPT, the twenty-minute hold
 * expires and another customer can buy the device outright. Calling this
 * before fulfilling such an order is what turns a silent oversell into a
 * flagged one.
 *
 * `outOfStock` is the test, not `reservedFor`. A device merely reserved by
 * another in-flight checkout has not been sold — that checkout may still fail,
 * and treating it as lost would refuse a customer who has actually paid.
 *
 * @param {string[]} ids  variation ids from the order
 * @returns {Promise<string[]>} the ids that are gone, empty when all are fine
 */
async function soldAway(ids) {
  if (!ids?.length) return [];

  const gone = await SingleVariation.find({
    _id: { $in: ids },
    isAccessory: { $ne: true },
    outOfStock: true,
  })
    .select("_id")
    .lean();

  return gone.map((variation) => String(variation._id));
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
  soldAway,
  markSold,
  variationIdsFromOrder,
  HOLD_MS,
};
