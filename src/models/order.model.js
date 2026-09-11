const { Schema, model, models } = require("mongoose");

const statusEnum = [
  "pending_payment",
  // The bank answered REVIEW: a person there is checking the payment by hand.
  // Distinct from pending_payment, which means the bank never answered at all.
  // The difference matters because pending_payment orders get swept away as
  // abandoned carts after 12 hours, and a payment under review must not be.
  "under_review",
  "Processing",
  "Shipped",
  "Delivered",
  "Returned",
  "Refunded",
  "payment failed",
];
// Stripe and Paypal were removed once the bank gateway replaced them and the
// test orders placed under them were cleared. "Card" and "Manual" remain for
// the admin-created path, which takes payment outside the website.
const paidWithEnum = ["Card", "Manual", "BankOfAmerica"];
const shippingEnum = ["standard", "priority", "express"];

// One kind of thing — a real product line — typed properly, unlike the
// Stripe-shaped line_items array it's replacing, which forced products and
// fee lines (tax, shipping) into one untyped array and left every reader to
// guess the difference by checking for a productId. Fee lines live as their
// own top-level cents fields on the order instead (see shippingCents/
// taxCents below), not as fake items with no product behind them.
const OrderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    description: String,
    image: String,
    quantity: { type: Number, required: true, min: 1 },
    // Both derived from the same source (see src/utils/orderItems.js) so
    // they can never disagree the way unit_amount and totalPaid could in the
    // legacy shape — one recorded per unit, the other quantity-multiplied,
    // computed independently, with nothing enforcing they matched.
    unitPriceCents: { type: Number, required: true, min: 0 },
    lineTotalCents: { type: Number, required: true, min: 0 },
    // Which physical device went out of the door, copied from the variation at
    // checkout rather than looked up later. A snapshot for the same reason the
    // name and price are: the catalogue record can be edited or deleted, and
    // this has to still answer "is the phone on the bench the phone we sold
    // them?" a year afterwards, in a dispute. See utils/deviceIdentity.js.
    imei: String,
    serialNumber: String,
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    // Legacy Stripe-shaped shape. Being replaced by items/shippingCents/
    // taxCents/subtotalCents/totalCents below (see src/utils/orderItems.js).
    // Kept — not removed — until every order in the database has been
    // migrated to the new fields and every reader has switched over.
    line_items: Object,
    // The migration target. Populated going forward at checkout; backfilled
    // on existing orders by a one-off migration script, never derived live
    // on every read the way the old shape's total was.
    items: [OrderItemSchema],
    shippingCents: Number,
    taxCents: Number,
    // The rate that produced taxCents, recorded on the order rather than read
    // from config at refund time. Config is today's answer; this is the one
    // that was actually charged.
    taxRate: Number,
    subtotalCents: Number,
    totalCents: Number,
    // Clerk user id of the account that placed the order. This — not `email` —
    // is what ties an order to a person. `email` is free text from the checkout
    // form, so a logged-in customer who types a different address files the
    // order under that address and can never see it again; it is also useless
    // as evidence in a chargeback, since it only proves someone typed it.
    // Absent on orders predating this field and on admin-created Manual orders.
    userId: { type: String, index: true },

    // When the "how did you get on" email went out. One per order, ever —
    // its presence is what stops the daily job asking again, which is why it
    // is written before the send rather than after.
    reviewPromptSentAt: Date,

    // Placed without an account. The order is identified by a token in a link
    // instead of by a Clerk user id.
    guest: { type: Boolean, default: false },

    // The SHA-256 of that token, never the token. select:false keeps it out of
    // every query that does not ask, but the hashing is what protects it — see
    // utils/accessToken.js for why one is not a substitute for the other.
    guestAccessToken: { type: String, select: false },
    guestTokenExpiresAt: Date,

    // Chargeback evidence. The IP is a salted hash: the question a chargeback
    // asks is "did these two orders come from the same place", which a digest
    // answers, and the raw value would only add the ability to tell where the
    // customer lives.
    checkoutIpHash: { type: String, select: false },
    userAgent: { type: String, select: false },
    name: String,
    // Contact address for this order's receipt. Deliberately still the form
    // value: customers legitimately send a receipt somewhere other than their
    // account address. Ownership is userId's job, not this field's.
    email: String,
    phone: String,
    city: String,
    // Two-letter US state code, needed for the bank's address check (AVS).
    state: String,
    postal: String,
    street: String,
    country: String,
    shipping: { type: String, enum: shippingEnum },
    paid: Boolean,
    status: { type: String, enum: statusEnum },
    paidWith: { type: String, enum: paidWithEnum },
    // Bank of America (Secure Acceptance). boaTransactionUuid is generated by
    // us before the customer leaves for the gateway and echoed back on the
    // merchant POST — it's what makes a replayed confirmation a no-op.
    // boaTransactionId is the bank's own reference, needed to find the
    // transaction in the Business Center when issuing a refund.
    boaTransactionUuid: String,
    boaTransactionId: String,
    // The amount actually signed and sent to the bank at checkout (dollars,
    // rounded to the cent). merchantPost compares the bank's authorised
    // figure against this rather than only ever re-summing line_items at
    // confirmation time — a live recomputation validates against whatever the
    // order happens to total right now, not against what the customer was
    // actually shown and the bank actually agreed to. Absent on orders
    // created before this field existed; those fall back to the recomputed
    // total, same as before.
    signedAmount: Number,
    // Every order today is USD — this just makes that an explicit fact on
    // the document rather than an assumption baked into every consumer of
    // totalPaid, ahead of the day it stops being universally true.
    currency: { type: String, default: "USD" },
    // What the bank actually authorised (auth_amount), set once on ACCEPT.
    // Kept distinct from signedAmount so a partial authorisation is visible
    // as a fact in the data, not just as a reason a payment was refused.
    authorizedAmount: Number,
    authorizedAt: Date,
    // Capture happens at dispatch, not at checkout — this project has no
    // automated capture step yet, so this field exists for that later work
    // and is not populated by anything today. updatedAt cannot stand in for
    // it: an order can be touched for unrelated reasons after it is captured.
    capturedAt: Date,
    // The gateway's own decision string (ACCEPT/REVIEW/DECLINE/ERROR/CANCEL),
    // kept verbatim alongside the derived `status` — Decision Manager can
    // return a REVIEW for reasons `status` alone does not distinguish.
    boaDecision: String,
    reasonCode: String,
    avsResult: String,
    cvnResult: String,
    // Brand and last four only. A full card number never reaches this server.
    cardBrand: String,
    cardLast4: String,
    // Paid, but nobody should pack it. Set when a payment under review is
    // accepted after the device has already sold to another customer — money
    // taken, nothing to ship. Deliberately a flag rather than a status value:
    // the order genuinely is paid, and rewriting status to "payment failed"
    // would hide a charge that really happened. A person has to resolve it,
    // which is why the reason is stored in words rather than a code.
    // How the order got to the customer.
    //
    // No shippedAt or deliveredAt in here on purpose, even though a shipment
    // is what sets them. Both already exist at the top level and the return
    // window reads them — resolveWindowStart falls back to shippedAt + 3 days
    // when no delivery was recorded. A second copy is a second thing to keep
    // in step, and the day they disagree the customer's 30 days start on the
    // wrong date.
    fulfilment: {
      carrier: String,
      trackingNumber: String,
      labelUrl: String,
      // Who marked it shipped. Not shown to the customer.
      shippedBy: String,
    },

    fulfilmentBlocked: { type: Boolean, default: false },
    fulfilmentBlockReason: String,
    // When the review pending window ran out and nothing had actioned it. The
    // authorisation is NOT reversed by that sweep — Secure Acceptance keys
    // cannot return money — so this marks an order still needing a manual
    // reversal in the Business Center.
    reviewAutoRejectedAt: Date,
    // Set once, by processRefund, and never after. UpCell has no refund API
    // credentials — Secure Acceptance keys can only take payments, never
    // return them — so this records what a staff member calculated and
    // approved, not a payment that actually moved. The real refund still has
    // to be typed into the Business Center by hand, by Raymond or Yasir.
    refund: {
      // The line items' totalPaid, summed, before the fee — device and
      // accessory rows only, never the tax or shipping line.
      itemsTotal: Number,
      // 15% of itemsTotal, or 0 if waived. Never applied to tax or shipping —
      // the client's confirmed rule only ever mentions "Devices" and never
      // charges a restocking fee on money that was not paid for goods.
      restockingFee: Number,
      restockingFeeWaived: Boolean,
      // Required by the controller whenever restockingFeeWaived is true, so a
      // waived fee always has a reason attached, not just a checked box.
      waiveReason: String,
      // The 8% sales tax charged on the returned items, handed back in full.
      // Confirmed by the client on 9 Sep 2026; refunds recorded before that
      // date have no such figure and left the tax with UpCell.
      taxRefunded: Number,
      // itemsTotal minus restockingFee plus taxRefunded. What the customer is
      // owed, and the figure staff type into the Business Center.
      amount: Number,
      // productIds of the exact line items refunded. A partial refund on a
      // multi-item order needs this to say which items, not just how much.
      itemIds: [String],
      notes: String,
      approvedBy: String,
      approvedAt: Date,
      // Recording a refund does not move any money — the amount still has to be
      // typed into the Business Center by hand, because the Secure Acceptance
      // keys cannot return funds. Until that happens the customer holds an
      // email saying they were refunded and has nothing in their account.
      //
      // These two say whether that step was actually done. Without them the
      // only record of it is in someone's memory, and "did anyone enter this?"
      // has no answer.
      enteredAtBankAt: Date,
      enteredAtBankBy: String,
    },
    // When the customer actually received the order. The 30-day return window
    // is counted from here, not from createdAt — an order placed on the 1st and
    // delivered on the 10th gives the customer 30 days from the 10th.
    //
    // Set once, the first time the status becomes Delivered, and never moved
    // afterwards: a status corrected back and forth must not quietly restart
    // someone's return window.
    deliveredAt: Date,

    // When the parcel actually left. Used only as a fallback for the return
    // window: if a delivery was never recorded, the window starts three days
    // after this rather than from the order date, which would eat however long
    // the parcel spent in transit out of the customer's 30 days.
    //
    // Stamped once, like deliveredAt, so a status corrected back and forth
    // cannot restart anybody's window.
    shippedAt: Date,
  },
  { timestamps: true }
);

// sparse: true — Manual orders have no transaction id at all,
// and a plain unique index would treat every one of those missing values as
// the same null and collide. sparse skips indexing docs where the field is
// absent, so uniqueness only applies to orders that actually have an ID.
OrderSchema.index({ boaTransactionUuid: 1 }, { unique: true, sparse: true });
// Same reasoning as boaTransactionUuid above: without this, the atomic claim
// in merchantPost guarantees only that one writer wins per order — nothing
// stops the same bank transaction id from ending up recorded against two
// different orders if a reference number were ever resolved wrong. sparse,
// because Manual orders and orders still pending never had a bank transaction.
OrderSchema.index({ boaTransactionId: 1 }, { unique: true, sparse: true });
// Claiming guest orders into an account after sign-in looks orders up by
// email and guest flag.
OrderSchema.index({ email: 1, guest: 1 });

OrderSchema.index({ email: 1, paid: 1 });
// Two orders sharing a tracking number means one parcel, two answers. Sparse
// because most orders have not shipped yet, and those must not all collide on
// a missing value.
OrderSchema.index({ "fulfilment.trackingNumber": 1 }, { sparse: true });

OrderSchema.index({ status: 1, updatedAt: -1 });
OrderSchema.index({ createdAt: 1 });

const Order = models?.Order || model("Order", OrderSchema);

module.exports = Order;
