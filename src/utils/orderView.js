// What a customer is allowed to see of their own order.
//
// An allowlist, deliberately, and this is the whole reason the file exists.
// The endpoint used to answer with the order document minus seven fields —
// name, email, phone, city, postal, street, country — and everything else went
// out: cardBrand, cardLast4, avsResult, cvnResult, boaTransactionId,
// signedAmount, authorizedAmount, userId, state, and the full refund block
// down to which staff member entered it at the bank.
//
// A denylist is wrong for this in a way that gets worse over time. It leaks
// every field added to the schema afterwards, silently, and nobody notices
// until somebody reads a response. Naming what may leave means a new field is
// private until a person decides otherwise.
//
// cardBrand and cardLast4 are the one payment detail kept. A customer looking
// at three orders needs to know which card paid for this one, and the last
// four digits are what the bank prints on their statement. Everything else the
// gateway returned is for reconciliation, not for the customer.

/**
 * One order, as its owner may see it.
 *
 * @param {object} order - a Mongoose document or a lean object
 * @returns {object} an allowlisted view — never the document
 */
const { trackingUrlFor } = require("./carrierTracking");

function toCustomerOrder(order) {
  if (!order) return null;

  const source = typeof order.toObject === "function" ? order.toObject() : order;

  return {
    _id: String(source._id),
    status: source.status,
    paid: source.paid,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,

    // The devices themselves. IMEI and serial stay: they identify the units
    // this person bought and paid for, and they are what a customer needs when
    // they call the carrier or claim on insurance.
    items: (source.items || []).map((item) => ({
      productId: item.productId ? String(item.productId) : undefined,
      name: item.name,
      description: item.description,
      image: item.image,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
      imei: item.imei,
      serialNumber: item.serialNumber,
    })),

    // The four figures the bank was sent.
    subtotalCents: source.subtotalCents,
    shippingCents: source.shippingCents,
    taxCents: source.taxCents,
    totalCents: source.totalCents,
    taxRate: source.taxRate,

    // Where it is going, and how.
    name: source.name,
    email: source.email,
    phone: source.phone,
    street: source.street,
    city: source.city,
    state: source.state,
    postal: source.postal,
    country: source.country,
    shipping: source.shipping,

    // Which card, for a customer reconciling against their statement.
    paidWith: source.paidWith,
    cardBrand: source.cardBrand,
    cardLast4: source.cardLast4,

    shippedAt: source.shippedAt,
    deliveredAt: source.deliveredAt,

    // Where the parcel is. shippedBy is a staff name and stays behind.
    fulfilment: source.fulfilment?.trackingNumber
      ? {
          carrier: source.fulfilment.carrier,
          trackingNumber: source.fulfilment.trackingNumber,
          // Built here rather than on the page, so the account and the email
          // send a customer to the same place.
          trackingUrl: trackingUrlFor(source.fulfilment.carrier, source.fulfilment.trackingNumber),
        }
      : undefined,

    // What they were refunded, not who approved it or when it was keyed in.
    refund: source.refund
      ? {
          amount: source.refund.amount,
          itemsTotal: source.refund.itemsTotal,
          taxRefunded: source.refund.taxRefunded,
          itemIds: (source.refund.itemIds || []).map(String),
          approvedAt: source.refund.approvedAt,
        }
      : undefined,

    // The legacy shape, for a receipt written before the chunk 6 migration.
    // Carried only when there is no items[] to carry instead, and dropped
    // entirely by chunk 7.
    line_items: (source.items || []).length ? undefined : source.line_items,
  };
}

/**
 * Whether this caller owns this order.
 *
 * Three ways, in order of how much they prove:
 *
 *   1. An admin. Admins read the full document through the admin routes, not
 *      this one, but they are never refused here either.
 *   2. The Clerk user id matches. This is the real answer, and it works even
 *      when somebody typed a different address into the checkout form than the
 *      one on their account — which used to lock them out of their own order.
 *   3. A verified email match, and only for an order with no userId at all.
 *      Orders placed before userId was recorded have nothing else to match on.
 *      Verified matters: an unverified address is a string somebody typed, so
 *      matching on it would let anyone claim an order by signing up with the
 *      right email and never proving it.
 */
function ownsOrder(user, order) {
  if (!user || !order) return false;
  if (user.role === "admin") return true;
  if (order.userId && user.id) return String(order.userId) === String(user.id);
  if (order.userId) return false;

  if (!user.emailVerified) return false;

  const claimed = String(user.email || "").trim().toLowerCase();
  const onOrder = String(order.email || "").trim().toLowerCase();

  return Boolean(claimed) && claimed === onOrder;
}

module.exports = { toCustomerOrder, ownsOrder };
