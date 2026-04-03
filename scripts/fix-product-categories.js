require("dotenv").config();
const mongoose = require("mongoose");
const ParentProduct = require("../schema/parentProduct");
const SingleVariation = require("../schema/singleVariation");
const ShopCategory = require("../schema/shopCategory");

function resolveCategoryName(modelName = "") {
  if (modelName.startsWith("iPhone")) {
    if (modelName.includes("Pro Max")) return "iPhone Pro Max";
    if (modelName.includes("Pro")) return "iPhone Pro";
    if (modelName.includes("Plus")) return "iPhone Plus";
    return "iPhone";
  }

  if (modelName.startsWith("iPad mini")) return "iPad mini";
  if (modelName.startsWith("iPad Air")) return "iPad Air";
  if (modelName.startsWith("iPad Pro")) return "iPad Pro";
  if (modelName.startsWith("iPad")) return "iPad";

  if (modelName.startsWith("MacBook Air")) return "MacBook Air";
  if (modelName.startsWith("MacBook Pro")) return "MacBook Pro";

  return "";
}

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  const apply = process.argv.includes("--apply");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const categories = await ShopCategory.find({}, "_id modelName").lean();
  const categoryMap = new Map(categories.map((category) => [category.modelName, category]));
  const parents = await ParentProduct.find({}, "modelName categoryName categoryId").sort({ modelName: 1 });

  const updates = [];

  for (const parent of parents) {
    const categoryName = resolveCategoryName(parent.modelName || "");
    const category = categoryMap.get(categoryName);

    if (!categoryName || !category) {
      continue;
    }

    const needsUpdate =
      String(parent.categoryId || "") !== String(category._id) ||
      (parent.categoryName || "") !== categoryName;

    if (needsUpdate) {
      updates.push({
        parentId: parent._id,
        modelName: parent.modelName,
        categoryName,
        categoryId: category._id,
      });
    }
  }

  if (!updates.length) {
    console.log("No category changes needed.");
    await mongoose.disconnect();
    return;
  }

  console.log(`${apply ? "Applying" : "Planned"} ${updates.length} product family category updates:\n`);
  for (const update of updates) {
    console.log(`- ${update.modelName} => ${update.categoryName}`);
  }

  if (apply) {
    for (const update of updates) {
      await ParentProduct.findByIdAndUpdate(update.parentId, {
        categoryName: update.categoryName,
        categoryId: update.categoryId,
      });

      await SingleVariation.updateMany(
        { parentCatagory: update.parentId },
        {
          $set: {
            categoryName: update.categoryName,
            categoryId: update.categoryId,
          },
        }
      );
    }

    console.log(`\nApplied ${updates.length} updates successfully.`);
  } else {
    console.log("\nRun with --apply to save these changes.");
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
