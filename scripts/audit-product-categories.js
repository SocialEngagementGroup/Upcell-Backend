require("dotenv").config();
const mongoose = require("mongoose");
const ParentProduct = require("../schema/parentProduct");
const ShopCategory = require("../schema/shopCategory");

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const categories = await ShopCategory.find({}, "modelName").sort({ modelName: 1 }).lean();
  const parents = await ParentProduct.find({}, "modelName categoryName categoryId").sort({ modelName: 1 }).lean();

  console.log("Shop categories:");
  for (const category of categories) {
    console.log(`- ${category.modelName}`);
  }

  console.log("\nParent products:");
  for (const parent of parents) {
    console.log(`- ${parent.modelName} => ${parent.categoryName || "NO_CATEGORY"}`);
  }

  const summary = parents.reduce((acc, parent) => {
    const key = parent.categoryName || "NO_CATEGORY";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log("\nCategory counts:");
  for (const [categoryName, count] of Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${categoryName}: ${count}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
