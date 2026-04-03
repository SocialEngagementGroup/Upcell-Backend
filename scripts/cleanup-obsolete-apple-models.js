require("dotenv").config();
const mongoose = require("mongoose");
const ParentProduct = require("../schema/parentProduct");
const SingleVariation = require("../schema/singleVariation");

const obsoleteModelNames = [
  "iPad (A16)",
  "iPad (10th Gen)",
  "iPad (9th Gen)",
  "iPad mini (A17 Pro)",
  "iPad mini (6th Gen)",
  "iPad Air (5th Gen)",
  "iPad Pro 11-inch (M1)",
  "iPad Pro 12.9-inch (M1)",
  "iPad Pro 11-inch (M2)",
  "iPad Pro 12.9-inch (M2)",
];

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const parents = await ParentProduct.find({ modelName: { $in: obsoleteModelNames } }, "_id modelName");

  if (!parents.length) {
    console.log("No obsolete Apple model families found.");
    await mongoose.disconnect();
    return;
  }

  const parentIds = parents.map((parent) => parent._id);
  await SingleVariation.deleteMany({ parentCatagory: { $in: parentIds } });
  await ParentProduct.deleteMany({ _id: { $in: parentIds } });

  console.log(`Removed ${parents.length} obsolete parent families:`);
  parents
    .map((parent) => parent.modelName)
    .sort((left, right) => left.localeCompare(right))
    .forEach((name) => console.log(`- ${name}`));

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
