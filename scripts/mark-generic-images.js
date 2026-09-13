#!/usr/bin/env node
/**
 * Marks the product photos that are stand-ins rather than photos of one exact
 * variant.
 *
 *   node scripts/mark-generic-images.js            dry run — prints, changes nothing
 *   node scripts/mark-generic-images.js --write    actually writes
 *
 * The seeded catalogue does not have a photo per variant. One MacBook Pro M5
 * Max picture is stored on all 96 of its variants, one iPad Air M4 picture on
 * all 32, and so on. Those are placeholders, and the frontend's local image
 * manifest usually has a better, model- and colour-specific photo for them.
 *
 * A photo an admin uploaded is the opposite: it belongs to that product and
 * must be shown exactly as uploaded. Both cases look identical in the database
 * — a Cloudinary id on a variation — so this marks the first kind, and the
 * frontend then knows which images it may improve on and which it must not
 * touch. Without the distinction an admin uploads one photo and the site shows
 * another, which is the bug this exists to stop.
 *
 * The test is how many distinct model-and-colour combinations use a photo, not
 * how many variations. The iPhone 13 Pro in gold is sold at 128GB, 256GB and
 * 512GB and all three share one photo — correctly, since storage is invisible
 * from the outside. That is one combination, so the photo is specific. The
 * MacBook Pro M5 Max photo covers dozens of different colours and screen
 * sizes, so it is a stand-in. Counting variations instead of combinations
 * marks 954 of 957 products, which is how this was first written and wrong.
 *
 * Safe to re-run: it recomputes from scratch and only writes what differs.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const variations = mongoose.connection.collection("singlevariations");

  const docs = await variations
    .find({}, { projection: { image: 1, imagePublicId: 1, imageIsGeneric: 1, productName: 1, color: 1 } })
    .toArray();

  // Which distinct model-and-colour combinations each photo covers. Keyed on
  // the public id where there is one and the url otherwise, so a product still
  // on a legacy path is counted alongside the rest rather than skipped.
  const combinations = new Map();
  for (const doc of docs) {
    const key = doc.imagePublicId || doc.image;
    if (!key) continue;
    const combination = `${doc.productName || ""}|${doc.color?.name || ""}`.toLowerCase();
    if (!combinations.has(key)) combinations.set(key, new Set());
    combinations.get(key).add(combination);
  }
  const useCount = new Map(
    [...combinations.entries()].map(([key, set]) => [key, set.size])
  );

  const toGeneric = [];
  const toSpecific = [];

  for (const doc of docs) {
    const key = doc.imagePublicId || doc.image;
    const isGeneric = Boolean(key) && useCount.get(key) > 1;
    // A document with no field at all is rewritten too, not just one whose
    // value disagrees. Leaving `false` implicit would work — the frontend reads
    // it as falsy either way — but the field then does not exist to be queried
    // or indexed on, which is the same trap isAccessory had.
    const current = doc.imageIsGeneric;
    if (typeof current === "boolean" && current === isGeneric) continue;
    (isGeneric ? toGeneric : toSpecific).push(doc._id);
  }

  const shared = [...useCount.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1]);

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`variations            : ${docs.length}`);
  console.log(`distinct photos       : ${useCount.size}`);
  console.log(`photos covering 2+ combos: ${shared.length}`);
  console.log(`  -> mark as stand-in : ${toGeneric.length}`);
  console.log(`  -> mark as specific : ${toSpecific.length}`);

  if (shared.length) {
    console.log("\nphotos covering the most model+colour combinations:");
    for (const [key, count] of shared.slice(0, 10)) {
      console.log(`  ${String(count).padStart(4)}x  ${key.slice(0, 70)}`);
    }
  }

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written.");
    await mongoose.disconnect();
    return;
  }

  if (toGeneric.length) {
    await variations.updateMany({ _id: { $in: toGeneric } }, { $set: { imageIsGeneric: true } });
  }
  if (toSpecific.length) {
    await variations.updateMany({ _id: { $in: toSpecific } }, { $set: { imageIsGeneric: false } });
  }

  console.log("\nWROTE changes");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
