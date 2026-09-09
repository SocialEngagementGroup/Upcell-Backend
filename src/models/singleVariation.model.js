const mongoose = require("mongoose");

const singleVariationSchema = new mongoose.Schema({
    parentCatagory: {type: mongoose.Schema.Types.ObjectId, index: true},
    // The readable half of /product/iphone-air/iphone-air-256gb-space-black,
    // built from name + storage + colour by src/utils/slug.js.
    //
    // The index below is unique and sparse: unique because this is how a
    // product is looked up, sparse because a record written before slugs
    // existed has none, and without sparse every one of those missing values
    // would collide with every other as a duplicate null.
    slug: String,
    productName: { type: String, index: true },
    categoryName: { type: String, index: true },
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
singleVariationSchema.index({ parentCatagory: 1, outOfStock: 1, price: 1 });
singleVariationSchema.index({ categoryName: 1, storage: 1, price: 1 });
singleVariationSchema.index({ productName: 1, price: 1 });

const SingVariation =mongoose.models.SingVariation || mongoose.model("SingleVariation", singleVariationSchema)

module.exports = SingVariation
