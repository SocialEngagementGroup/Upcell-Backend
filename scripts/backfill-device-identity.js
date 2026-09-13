#!/usr/bin/env node
/**
 * Fills in deviceType, carrierStatus and refurbState on the existing catalogue.
 *
 *   node scripts/backfill-device-identity.js            dry run
 *   node scripts/backfill-device-identity.js --write    apply
 *
 * All three fields are new. Mongoose defaults apply on write, not to documents
 * that already exist, so without this every row reads as having no device type
 * and no refurb state — and the shop listing, which now hides anything that is
 * not SELLABLE, would hide the entire catalogue.
 *
 * deviceType comes from categoryName. Every one of the ten real categories
 * maps cleanly; anything unrecognised is reported rather than guessed, because
 * filing a Mac as a phone would then demand an IMEI it will never have.
 *
 * This does NOT invent identities. A phone with no IMEI stays a phone with no
 * IMEI — that gap is real and only a person with the device in their hand can
 * close it. Setting IDENTITY_REQUIRED=true before that walk has happened is
 * what would refuse checkout for most of the shop, which is why the flag is
 * off and X9 in PIPELINE.md is a physical audit rather than a script.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const SingleVariation = require("../src/models/singleVariation.model");
const { deviceTypeFromCategory, hasIdentity } = require("../src/constants/deviceIdentity");

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  const products = await SingleVariation.find({})
    .select("categoryName isAccessory deviceType carrierStatus refurbState imei serialNumber productName")
    .lean();

  const counts = { PHONE: 0, TABLET: 0, LAPTOP: 0, ACCESSORY: 0 };
  const unmapped = [];
  const writes = [];

  let alreadyTyped = 0;
  let carrierSet = 0;
  let refurbSet = 0;

  for (const product of products) {
    const update = {};

    if (product.deviceType) {
      alreadyTyped += 1;
      counts[product.deviceType] = (counts[product.deviceType] || 0) + 1;
    } else {
      const deviceType = deviceTypeFromCategory(product.categoryName, { isAccessory: product.isAccessory });

      if (!deviceType) {
        unmapped.push(`${product.productName || "(no name)"} — category "${product.categoryName || "none"}"`);
      } else {
        update.deviceType = deviceType;
        counts[deviceType] += 1;
      }
    }

    // Unlocked is the honest default for a used-device shop: it is what most
    // stock is, and it is the claim a buyer checks first. Anything locked has
    // to be set deliberately, which is the right way round.
    if (!product.carrierStatus) {
      update.carrierStatus = "UNLOCKED";
      carrierSet += 1;
    }

    if (!product.refurbState) {
      update.refurbState = "SELLABLE";
      refurbSet += 1;
    }

    if (Object.keys(update).length) {
      writes.push({ updateOne: { filter: { _id: product._id }, update: { $set: update } } });
    }
  }

  console.log(`Products                : ${products.length}`);
  console.log(`  already had a type    : ${alreadyTyped}`);
  console.log(`  typed by this run     : ${writes.filter((w) => w.updateOne.update.$set.deviceType).length}`);
  console.log(`  carrierStatus set     : ${carrierSet}`);
  console.log(`  refurbState set       : ${refurbSet}`);
  console.log("");
  console.log("By device type:");
  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type.padEnd(10)} ${count}`);
  }

  if (unmapped.length) {
    console.log(`\nUNMAPPED (${unmapped.length}) — left alone rather than guessed:`);
    unmapped.slice(0, 20).forEach((line) => console.log(`  ${line}`));
    if (unmapped.length > 20) console.log(`  ...and ${unmapped.length - 20} more`);
  }

  // What the identity audit is actually facing. Reported here because the
  // number is the argument for doing it, and nobody has seen it before.
  const missing = products.filter((product) => {
    const deviceType = product.deviceType
      || deviceTypeFromCategory(product.categoryName, { isAccessory: product.isAccessory });
    return !hasIdentity({ ...product, deviceType }).ok;
  });

  console.log(`\nDevices with no identity recorded: ${missing.length} of ${products.length}`);
  console.log("  These are what X9 has to close before IDENTITY_REQUIRED can be turned on.");
  console.log("  Nothing here invents one — only a person holding the device can.");

  if (!WRITE) {
    console.log("\nDry run — nothing was written.");
    await mongoose.disconnect();
    return;
  }

  if (writes.length) {
    const result = await SingleVariation.bulkWrite(writes, { ordered: false });
    console.log(`\nUpdated ${result.modifiedCount} of ${writes.length}.`);
  } else {
    console.log("\nNothing to write.");
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main };
