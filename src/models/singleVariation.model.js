const mongoose = require("mongoose");

const singleVariationSchema = new mongoose.Schema({
    parentCatagory: {type: mongoose.Schema.Types.ObjectId, index: true},
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

singleVariationSchema.index({ parentCatagory: 1, outOfStock: 1, price: 1 });
singleVariationSchema.index({ categoryName: 1, storage: 1, price: 1 });
singleVariationSchema.index({ productName: 1, price: 1 });

const SingVariation =mongoose.models.SingVariation || mongoose.model("SingleVariation", singleVariationSchema)

module.exports = SingVariation
