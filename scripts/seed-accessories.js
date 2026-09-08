// Creates the add-on accessories as real catalogue products.
//
//   npm run seed-accessories
//
// They were previously hard-coded in the frontend with invented ids like
// "addon_case". The cart filters to real database ids, so those were silently
// discarded: the customer was shown "Product and accessories added", charged
// for the phone alone, and never received the accessories.
//
// As real products they need no special handling — cart, checkout, tax,
// receipts and the admin order view all work on them unchanged. isAccessory
// keeps them out of the shop listing and out of the single-unit stock rules.
//
// Safe to run more than once: matches on name and updates rather than
// duplicating.
require("dotenv").config();

const mongoose = require("mongoose");
const { connectToDb } = require("../src/config/database");
const SingleVariation = require("../src/models/singleVariation.model");

const ACCESSORIES = [
  {
    productName: "Clear Case (MagSafe)",
    description: "Crystal clear, yellowing-resistant protection.",
    price: 39,
    condition: "New",
    storage: "One size",
    color: { name: "Clear", value: "#E8E8ED" },
    image: "/product-images/accessories/clear-case-magsafe.png",
  },
  {
    productName: "Ultra-Glass Protector",
    description: "Edge-to-edge scratch and impact defense.",
    price: 19,
    condition: "New",
    storage: "One size",
    color: { name: "Clear", value: "#E8E8ED" },
    image: "/product-images/accessories/ultra-glass-protector.png",
  },
];

(async () => {
  await connectToDb();

  console.log("");
  for (const accessory of ACCESSORIES) {
    const existing = await SingleVariation.findOne({
      productName: accessory.productName,
    });

    if (existing) {
      await SingleVariation.updateOne(
        { _id: existing._id },
        { $set: { ...accessory, isAccessory: true, outOfStock: false } }
      );
      console.log("  updated  " + existing._id + "  " + accessory.productName +
        "  $" + accessory.price);
    } else {
      const created = await SingleVariation.create({
        ...accessory,
        isAccessory: true,
        outOfStock: false,
      });
      console.log("  created  " + created._id + "  " + accessory.productName +
        "  $" + accessory.price);
    }
  }

  const total = await SingleVariation.countDocuments({ isAccessory: true });
  const devices = await SingleVariation.countDocuments({ isAccessory: { $ne: true } });
  console.log("\n  " + total + " accessories, " + devices + " devices in the catalogue\n");

  await mongoose.disconnect();
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});
