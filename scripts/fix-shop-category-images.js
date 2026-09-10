#!/usr/bin/env node
/**
 * Repoints shop-category images at Cloudinary.
 *
 *   node scripts/fix-shop-category-images.js            dry run
 *   node scripts/fix-shop-category-images.js --write    apply
 *
 * The ten shop categories were seeded with local paths — "/staticImages/
 * category-iphone.png" and two others. Those files were moved to Cloudinary
 * by migrate-images-to-cloudinary.js and the local copies deleted, so the
 * rows have been carrying URLs that 404 ever since. The admin categories page
 * renders the image with no fallback, so it shows a broken icon.
 *
 * The defaults themselves are fixed in constants/shopCategoryDefaults.js.
 * This is for the rows that were already written from the old ones.
 *
 * Only rows still holding a /staticImages/ path are touched. A category
 * somebody has since given a real picture keeps it.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { SHOP_CATEGORY_DEFAULTS } = require("../constants/shopCategoryDefaults");

const WRITE = process.argv.includes("--write");

const isDeadPath = (image) =>
  typeof image?.url === "string" && image.url.startsWith("/staticImages/");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const collection = mongoose.connection.db.collection("shopcategories");

  console.log(`Database: ${mongoose.connection.name}`);
  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  const byName = new Map(SHOP_CATEGORY_DEFAULTS.map((item) => [item.modelName, item.images]));
  const rows = await collection.find({}).toArray();

  let fixed = 0;
  let skipped = 0;

  for (const row of rows) {
    const dead = (row.images || []).some(isDeadPath);

    if (!dead) {
      skipped += 1;
      continue;
    }

    const replacement = byName.get(row.modelName);
    if (!replacement) {
      // A category nobody has a picture for. Emptied rather than left
      // pointing at a file that is not there: no image renders as no image,
      // a dead path renders as a broken one.
      console.log(`  ${row.modelName.padEnd(16)} no default — clearing`);
      if (WRITE) await collection.updateOne({ _id: row._id }, { $set: { images: [] } });
      fixed += 1;
      continue;
    }

    console.log(`  ${row.modelName.padEnd(16)} ${row.images[0].url}  ->  ${replacement[0].publicId}`);
    if (WRITE) await collection.updateOne({ _id: row._id }, { $set: { images: replacement } });
    fixed += 1;
  }

  console.log(`\n${fixed} to fix, ${skipped} already fine.`);
  if (!WRITE && fixed) console.log("Dry run — nothing was written.");

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
