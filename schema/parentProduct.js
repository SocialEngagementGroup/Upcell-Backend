const mongoose = require("mongoose")


const  parentProductSchema = new mongoose.Schema({
    modelName: String,
    categoryName: String,
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ShopCategory" },
    description: String,
    images: {type: [mongoose.Schema.Types.Mixed],
            default: [] },
})

parentProductSchema.index({ modelName: 1 });

const ParentProduct =mongoose.models.ParentProduct || mongoose.model("ParentProduct", parentProductSchema)

module.exports = ParentProduct
