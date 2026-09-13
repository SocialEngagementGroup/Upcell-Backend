const mongoose = require("mongoose");
const {
  DEVICE_TYPES,
  CARRIER_STATUSES,
  REFURB_STATES,
} = require("../constants/deviceIdentity");

const singleVariationSchema = new mongoose.Schema({
    parentCatagory: { type: mongoose.Schema.Types.ObjectId },
    // The readable half of /product/iphone-air/iphone-air-256gb-space-black,
    // built from name + storage + colour by src/utils/slug.js.
    //
    // The index below is unique and sparse: unique because this is how a
    // product is looked up, sparse because a record written before slugs
    // existed has none, and without sparse every one of those missing values
    // would collide with every other as a duplicate null.
    slug: String,
    productName: { type: String },
    categoryName: { type: String },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ShopCategory" },
    description: String,
    storage: { type: String, index: true },
    color: Object,
    price: { type: Number, index: true },
    discountPrice: Number,
    originalPrice: Number,
    reviewScore: Number,
    peopleReviewed: Number,
    condition: String,
    // The cosmetic grade on the returns scale: EXCELLENT | GOOD | FAIR | FAIL.
    //
    // Separate from `condition`, which was free text on a different scale
    // (Mint, New, Excellent, Good). A returned device is compared against this
    // to decide whether it relists unchanged or is re-graded, and that
    // comparison needs both sides on one scale.
    //
    // scripts/migrate-condition-to-grade.js filled it for the existing
    // catalogue; conditionLegacy keeps whatever the product said before.
    cosmeticGrade: { type: String, index: true },
    conditionLegacy: String,
    // Battery health as a percentage, recorded so the next buyer knows and so
    // a return can be compared against it. Never a reason to deduct.
    batteryHealth: Number,
    // Where this unit came from. Only bulk stock can go back to a supplier —
    // a device bought from a member of the public has nobody to return it to.
    //
    // Defaults to UNKNOWN rather than to either real value, and UNKNOWN is
    // permissive: the field is new and most of the catalogue has not been
    // filled in, so blocking the supplier route on every existing device would
    // cost real recovery value. Only a source known to be an individual
    // blocks it.
    // Whether the handset is tied to a carrier. Shown on the product page,
    // because "unlocked" is the first thing a phone buyer checks and the last
    // thing they want to discover after it arrives.
    carrierStatus: {
      type: String,
      enum: CARRIER_STATUSES,
      default: "UNLOCKED",
    },

    // What kind of thing this row is, which decides what identifies it: a
    // phone shows an IMEI, a tablet or laptop shows a serial, an accessory
    // shows neither and never will.
    deviceType: {
      type: String,
      enum: DEVICE_TYPES,
    },

    // Whether it can be sold as it stands. Separate from outOfStock, which
    // says whether it is on the shelf: a device with a battery below 80% is
    // in the building, works, and still must not be listed until the battery
    // is replaced.
    refurbState: {
      type: String,
      enum: REFURB_STATES,
      default: "SELLABLE",
      index: true,
    },

    acquisitionSource: {
      type: String,
      enum: ["BULK", "INDIVIDUAL", "UNKNOWN"],
      default: "UNKNOWN",
    },
    // Which physical device this is.
    //
    // Every variation is one unit, and until these existed nothing recorded
    // which unit it was. The returns inspection asks staff to confirm the
    // device sent back is the device that was sold, and the Return Policy page
    // promises customers that check happens — both were an honour system with
    // no sales record behind them.
    //
    // Two fields because Apple uses two: a phone or cellular iPad has a
    // 15-digit IMEI, a wifi iPad or MacBook has only a serial. Both optional —
    // accessories have neither, and the 954 products already in the catalogue
    // were entered before this existed. See src/utils/deviceIdentity.js.
    imei: String,
    serialNumber: String,
    image: String,
    // The Cloudinary public_id behind `image`, which is what every delivery
    // URL is actually built from — a public_id can be asked for at any width
    // and format, a stored URL cannot.
    //
    // These three were written by scripts/backfill-image-public-ids.js long
    // before they were declared here. Queries still returned them because they
    // all use .lean(), which hands back the raw document; but Mongoose strips
    // undeclared fields from a hydrated document, so any .save() on a product
    // silently deleted them. Declaring them closes that trap.
    imagePublicId: String,
    imageWidth: Number,
    imageHeight: Number,
    // True when `image` is a stand-in shared across many products rather than a
    // photo of this exact variant — the seeded catalogue gives all 96 MacBook
    // Pro M5 Max variants one single file, for instance.
    //
    // It is the difference between "this is the product's photo" and "this is
    // the best we had". A real photo is always shown as-is; a stand-in may be
    // improved on by the local image manifest. Anything uploaded through the
    // admin panel is a real photo, so this stays false for it.
    imageIsGeneric: { type: Boolean, default: false },
    outOfStock: {
        type: Boolean,
        default: false,
        index: true,
    },
    // A case or screen protector rather than a device.
    //
    // Accessories are real products so the cart, checkout, tax and receipts all
    // work on them without special cases — they were previously hard-coded in
    // the frontend with invented ids, which the cart then silently discarded,
    // so a customer was charged for the phone alone and told they had bought
    // accessories they never received.
    //
    // Two things differ from a device. They are not browsable: the shop lists
    // devices, and an accessory is offered on a device's own page. And they are
    // not single units, so the stock hold that stops one phone selling twice
    // does not apply — see services/inventory.js.
    isAccessory: {
        type: Boolean,
        default: false,
        index: true,
    },
    // Held while a customer is away at the bank's payment page. Every device is
    // a single unit, so without this two people can both be authorised for the
    // same phone and one of them has to be refunded by hand.
    //
    // A timestamp rather than a boolean on purpose: a held device frees itself
    // when the time passes, so a crash, a closed tab, or a customer who simply
    // wanders off cannot leave stock locked away forever with nothing to
    // release it.
    reservedUntil: { type: Date, index: true },
    // Which checkout holds it — the order's boaTransactionUuid. Lets a retry by
    // the same checkout re-take its own reservation instead of colliding with
    // itself, and lets the reservation be released precisely when that payment
    // fails rather than waiting for the clock.
    reservedFor: { type: String, index: true },
}, { timestamps: true })

singleVariationSchema.index({ slug: 1 }, { unique: true, sparse: true });
// One device, one record. Two units cannot share an IMEI, so this is what stops
// the same phone being entered twice under two products — which would sell one
// device to two customers, the exact failure the stock hold exists to prevent.
//
// Partial rather than sparse: sparse skips only missing values, and the
// catalogue is full of records that will never have an IMEI. Keyed on the field
// being a string so those are all ignored rather than colliding on null.
singleVariationSchema.index(
  { imei: 1 },
  { unique: true, partialFilterExpression: { imei: { $type: "string" } } }
);
singleVariationSchema.index(
  { serialNumber: 1 },
  { unique: true, partialFilterExpression: { serialNumber: { $type: "string" } } }
);
// parentCatagory, productName and categoryName have no index of their own.
// Each is the first field of one of the three compound indexes below, and
// MongoDB serves a prefix query from a compound index — so a separate
// single-field index would be a second copy that only costs writes. On one
// row per physical device, every product save pays for every index.
singleVariationSchema.index({ parentCatagory: 1, outOfStock: 1, price: 1 });
singleVariationSchema.index({ categoryName: 1, storage: 1, price: 1 });
singleVariationSchema.index({ productName: 1, price: 1 });

const SingVariation =mongoose.models.SingVariation || mongoose.model("SingleVariation", singleVariationSchema)

module.exports = SingVariation
