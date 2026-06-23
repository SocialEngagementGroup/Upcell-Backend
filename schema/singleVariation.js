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
})

singleVariationSchema.index({ parentCatagory: 1, outOfStock: 1, price: 1 });
singleVariationSchema.index({ categoryName: 1, storage: 1, price: 1 });
singleVariationSchema.index({ productName: 1, price: 1 });

const SingVariation =mongoose.models.SingVariation || mongoose.model("SingleVariation", singleVariationSchema)

module.exports = SingVariation
