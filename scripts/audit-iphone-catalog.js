require("dotenv").config();
const mongoose = require("mongoose");
const ParentProduct = require("../schema/parentProduct");
const SingleVariation = require("../schema/singleVariation");

const expectedVariantCounts = {
  "iPhone 13 mini": 18,
  "iPhone 13": 18,
  "iPhone 13 Pro": 20,
  "iPhone 13 Pro Max": 20,
  "iPhone 14": 18,
  "iPhone 14 Plus": 18,
  "iPhone 14 Pro": 16,
  "iPhone 14 Pro Max": 16,
  "iPhone 15": 15,
  "iPhone 15 Plus": 15,
  "iPhone 15 Pro": 16,
  "iPhone 15 Pro Max": 12,
  "iPhone 16": 15,
  "iPhone 16 Plus": 15,
  "iPhone 16 Pro": 16,
  "iPhone 16 Pro Max": 12,
  "iPhone 16e": 9,
  "iPhone 17": 10,
  "iPhone Air": 12,
  "iPhone 17 Pro": 9,
  "iPhone 17 Pro Max": 12,
  "iPhone 17e": 6,
};

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  for (const [modelName, expectedCount] of Object.entries(expectedVariantCounts)) {
    const parent = await ParentProduct.findOne({ modelName }, "_id").lean();
    const actualCount = parent
      ? await SingleVariation.countDocuments({ parentCatagory: parent._id })
      : 0;

    console.log(
      `${modelName}: parent=${parent ? "yes" : "no"} variants=${actualCount} expected=${expectedCount}`
    );
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
