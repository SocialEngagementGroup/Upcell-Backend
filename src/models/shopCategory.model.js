const mongoose = require("mongoose");

const shopCategorySchema = new mongoose.Schema({
  modelName: { type: String, required: true, unique: true },
  description: { type: String, default: "" },
  images: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
});

const ShopCategory =
  mongoose.models.ShopCategory || mongoose.model("ShopCategory", shopCategorySchema);

module.exports = ShopCategory;
