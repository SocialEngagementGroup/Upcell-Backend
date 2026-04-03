require("dotenv").config();
const mongoose = require("mongoose");
const SingleVariation = require("../schema/singleVariation");

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const variants = await SingleVariation.find({}, "productName storage categoryName").sort({ productName: 1, storage: 1 }).lean();

  for (const variant of variants) {
    console.log(`${variant.productName} [${variant.storage || "-"}] => ${variant.categoryName || "NO_CATEGORY"}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
