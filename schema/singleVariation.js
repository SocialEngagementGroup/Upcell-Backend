const mongoose = require("mongoose");

const singleVariationSchema = new mongoose.Schema({
    parentCatagory: {type: mongoose.Schema.Types.ObjectId},
    productName:String,
    categoryName: String,
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ShopCategory" },
    description: String,
    storage: String,
    color: Object,
    price: Number,
    discountPrice: Number,
    originalPrice: Number,
    reviewScore: Number,
    peopleReviewed: Number,
    condition: String,
    image: String,
    outOfStock: {
        type: Boolean,
        default: false,
    },
})

const SingVariation =mongoose.models.SingVariation || mongoose.model("SingleVariation", singleVariationSchema)

module.exports = SingVariation
