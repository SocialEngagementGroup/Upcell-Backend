const mongoose = require("mongoose")


const  parentProductSchema = new mongoose.Schema({
    modelName: String,
    // "iPhone Air" -> "iphone-air". See src/utils/slug.js.
    slug: String,
    categoryName: String,
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ShopCategory" },
    description: String,
    images: {type: [mongoose.Schema.Types.Mixed],
            default: [] },
}, { timestamps: true })

parentProductSchema.index({ modelName: 1 });
parentProductSchema.index({ slug: 1 }, { unique: true, sparse: true });

const ParentProduct =mongoose.models.ParentProduct || mongoose.model("ParentProduct", parentProductSchema)

module.exports = ParentProduct
