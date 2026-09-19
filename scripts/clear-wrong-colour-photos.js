#!/usr/bin/env node
/**
 * Takes the photo away from a product whose photo is the wrong colour.
 *
 *   node scripts/clear-wrong-colour-photos.js            dry run
 *   node scripts/clear-wrong-colour-photos.js --write    apply
 *
 * After backfill-product-photos.js, two photos were still standing in for
 * colours they are not:
 *
 *   hero-iphone15   19 products across 6 colours. It is the homepage marketing
 *                   banner — an iPhone 15 advert shown as the product shot for
 *                   an iPhone 17 Pro in Cosmic Orange.
 *   ipad-air-m4     32 products across 4 colours, mostly Starlight.
 *
 * Neither can be fixed by matching, because the photos do not exist: 22
 * model+colour combinations UpCell sells have never been photographed.
 *
 * So the honest answer is to show nothing. A customer choosing Ultramarine and
 * seeing a black phone believes that is what they are buying; a customer
 * seeing "no photo yet" knows exactly where they stand, and the shop stops
 * making a claim it cannot support.
 *
 * WHAT THIS DOES
 *
 *   - Finds photos used across more than one COLOUR. A photo shared by several
 *     models of the same colour is left alone — a Space Black MacBook Pro
 *     looks identical whether the chip is M4, M4 Pro or M4 Max, and that
 *     sharing is correct.
 *   - Unsets `imagePublicId` and `image` on those products, so
 *     resolveProductImageParts returns nothing and ProductImage renders the
 *     Cloudinary placeholder. Clearing only the public id would fall back to
 *     the legacy path, which 404s — the placeholder still appears, but after a
 *     wasted request and a console error.
 *   - Writes both previous values to an undo file first.
 *
 * Re-run it after new photographs are uploaded and backfill-product-photos.js
 * has placed them: products that found a colour-matched photo will no longer
 * be in the wrong-colour set, and will keep it.
 */
require("dotenv").config();
require("./lib/announce-db");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 30000 });
  const variations = mongoose.connection.collection("singlevariations");

  const products = await variations
    .find({}, { projection: { productName: 1, color: 1, imagePublicId: 1, image: 1 } })
    .toArray();

  const byPhoto = new Map();
  for (const p of products) {
    if (!p.imagePublicId) continue;
    if (!byPhoto.has(p.imagePublicId)) byPhoto.set(p.imagePublicId, []);
    byPhoto.get(p.imagePublicId).push(p);
  }

  const wrong = [];
  const shared = [];
  for (const [publicId, group] of byPhoto) {
    const colours = new Set(group.map((p) => p.color?.name));
    if (colours.size > 1) wrong.push({ publicId, group, colours: [...colours] });
    else if (group.length > 1) shared.push({ publicId, count: group.length });
  }

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`products                        : ${products.length}`);
  console.log(`photos shared within one colour : ${shared.length}   <- correct, left alone`);
  console.log(`photos spanning several colours : ${wrong.length}   <- these are wrong\n`);

  let affected = 0;
  for (const { publicId, group, colours } of wrong) {
    affected += group.length;
    console.log(`  ${publicId.split("/").pop().slice(0, 44)}  ${group.length} products, ${colours.length} colours`);
    const combos = {};
    for (const p of group) {
      const key = `${p.productName} — ${p.color?.name}`;
      combos[key] = (combos[key] || 0) + 1;
    }
    for (const [key, n] of Object.entries(combos).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(2)}x  ${key}`);
    }
  }

  console.log(`\nproducts that would show the placeholder instead : ${affected}`);

  if (!WRITE) {
    console.log("\nNothing written. Re-run with --write to apply.");
    return;
  }

  const ids = wrong.flatMap(({ group }) => group.map((p) => p._id));
  if (!ids.length) { console.log("nothing to do"); return; }

  const undoDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(undoDir, { recursive: true });
  const undo = path.join(undoDir, `cleared-photos-undo-${Date.now()}.json`);
  fs.writeFileSync(undo, JSON.stringify(
    wrong.flatMap(({ group }) => group.map((p) => ({
      _id: p._id,
      imagePublicId: p.imagePublicId ?? null,
      image: p.image ?? null,
    }))),
    null, 1
  ));
  console.log(`\nundo file written to ${undo}`);

  const result = await variations.updateMany(
    { _id: { $in: ids } },
    { $unset: { imagePublicId: "", image: "" } }
  );
  console.log(`products cleared : ${result.modifiedCount}`);
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
