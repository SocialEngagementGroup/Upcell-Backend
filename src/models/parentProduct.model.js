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

    // What customers have said, rolled up.
    //
    // Recomputed from the reviews collection whenever one is approved or
    // hidden, rather than counted on every product page load: a page shows one
    // average and 954 products would each be an aggregate. Stored on the
    // parent because that is what a product page is.
    //
    // Not to be confused with singleVariation.reviewScore /
    // peopleReviewed, which are seeded display numbers from before reviews
    // existed and are not derived from anything.
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
}, { timestamps: true })

parentProductSchema.index({ modelName: 1 });
parentProductSchema.index({ slug: 1 }, { unique: true, sparse: true });

const ParentProduct =mongoose.models.ParentProduct || mongoose.model("ParentProduct", parentProductSchema)

module.exports = ParentProduct
