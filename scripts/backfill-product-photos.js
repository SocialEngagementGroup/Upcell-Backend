#!/usr/bin/env node
/**
 * Gives each product its own photo, once, in the database.
 *
 *   node scripts/backfill-product-photos.js                dry run
 *   node scripts/backfill-product-photos.js --report       dry run + every row
 *   node scripts/backfill-product-photos.js --write        apply
 *
 * The catalogue holds 954 products and only about 174 distinct photos, because
 * one picture was stored on every colour of a model. Cloudinary already holds
 * 891 per-colour photos; nothing in the database points at them.
 *
 * A manifest in the frontend used to close that gap by guessing, in every
 * visitor's browser, on every render. That is the wrong place for a guess:
 * nobody reviews it, it costs 316 KB of bundle, and it only ever ran where
 * `imageIsGeneric` was set — which no production product carries, so the live
 * site and a developer's laptop showed different photos for the same phone.
 *
 * This does the same matching once, here, where the answer can be read before
 * it is applied. Afterwards the database is the only source of truth for what a
 * product looks like, and the browser just renders what it is given.
 *
 * WHAT IT WILL NOT DO
 *
 *   - It never clears a photo. A product whose best candidate scores below the
 *     threshold keeps what it has.
 *   - It never invents one. No match means no change, reported as a number to
 *     look at rather than filled with something plausible.
 *   - It writes `imagePublicId` only. The legacy `image` path stays exactly as
 *     it is, so a bad run is undone by restoring one field.
 *
 * READ THE DRY RUN. The matcher scores candidates and takes the best above 35;
 * a low score is a weak match, and `--report` prints every row with its score
 * so a person can judge before anything is written.
 */
require("dotenv").config();
require("./lib/announce-db");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { buildRecords, matchProductPhoto, MIN_SCORE } = require("./lib/photoMatcher");

const WRITE = process.argv.includes("--write");
const REPORT = process.argv.includes("--report");
// Off by default, and it should stay off.
//
// The matcher retries without the colour constraint when no photo of that
// colour exists, which is how an iPhone 16e in Ultramarine was offered
// 16_E_Black.png — the manifest holds only Black and White for that model.
// A wrong colour is worse than a repeated one: a customer choosing
// Ultramarine and seeing black believes they are looking at what they
// ordered. The colours that are missing are missing because nobody
// photographed them, and no script can close that.
const ALLOW_COLOUR_FALLBACK = process.argv.includes("--allow-colour-fallback");
const MANIFEST = path.join(__dirname, "data", "product-image-manifest.json");

// Worth looking at by hand even though it passed. The threshold says "good
// enough to use"; this says "good enough that nobody needs to check".
const CONFIDENT = 80;

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const records = buildRecords(manifest);

  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
  const variations = mongoose.connection.collection("singlevariations");

  const products = await variations
    .find({}, { projection: { productName: 1, categoryName: 1, color: 1, imagePublicId: 1 } })
    .toArray();

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`manifest photos : ${records.length}`);
  console.log(`products        : ${products.length}`);
  console.log(`threshold       : ${MIN_SCORE}\n`);

  const changes = [];
  const unchanged = [];
  const noMatch = [];
  const colourMissing = [];
  const weak = [];

  for (const product of products) {
    const match = matchProductPhoto(product, records);
    if (!match) { noMatch.push(product); continue; }
    if (match.matchedOn !== "model+colour" && !ALLOW_COLOUR_FALLBACK) {
      colourMissing.push({ product, match });
      continue;
    }
    if (match.publicId === product.imagePublicId) { unchanged.push(product); continue; }
    const row = { product, match };
    changes.push(row);
    if (match.score < CONFIDENT) weak.push(row);
  }

  const before = new Set(products.map((p) => p.imagePublicId).filter(Boolean));
  const after = new Set(products.map((p) => {
    const row = changes.find((c) => String(c.product._id) === String(p._id));
    return row ? row.match.publicId : p.imagePublicId;
  }).filter(Boolean));

  console.log(`already correct        : ${unchanged.length}`);
  console.log(`would change           : ${changes.length}`);
  console.log(`no confident match     : ${noMatch.length}   <- left exactly as they are`);
  console.log(`no photo of that colour: ${colourMissing.length}   <- left alone; see below`);
  console.log(`\ndistinct photos before : ${before.size}`);
  console.log(`distinct photos after  : ${after.size}`);
  console.log(`\nmatched on model+colour: ${changes.filter((c) => c.match.matchedOn === "model+colour").length}`);
  console.log(`matched on model only  : ${changes.filter((c) => c.match.matchedOn === "model only").length}`);
  console.log(`scoring under ${CONFIDENT}        : ${weak.length}   <- worth reading`);

  if (weak.length) {
    console.log("\nthe weakest matches, lowest first:");
    for (const { product, match } of [...weak].sort((a, b) => a.match.score - b.match.score).slice(0, 20)) {
      console.log(`  ${String(match.score).padStart(3)}  ${(product.productName || "").slice(0, 34).padEnd(34)} ${(product.color?.name || "-").slice(0, 16).padEnd(16)} -> ${match.originalPath.slice(0, 60)}`);
    }
  }

  if (colourMissing.length) {
    // The list to hand to whoever sources photographs. Each line is a colour
    // UpCell sells and has never photographed.
    const combos = {};
    colourMissing.forEach(({ product }) => {
      const key = `${product.productName} — ${product.color?.name || "(no colour)"}`;
      combos[key] = (combos[key] || 0) + 1;
    });
    console.log(`
colours sold but never photographed (${Object.keys(combos).length} of them):`);
    Object.entries(combos).sort((a, b) => b[1] - a[1])
      .forEach(([name, n]) => console.log(`  ${String(n).padStart(3)} units  ${name}`));
  }

  if (noMatch.length) {
    console.log("\nno match, keeping what they have:");
    const byName = {};
    noMatch.forEach((p) => { byName[p.productName || "(unnamed)"] = (byName[p.productName || "(unnamed)"] || 0) + 1; });
    Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([name, n]) => console.log(`  ${String(n).padStart(3)}  ${name}`));
  }

  if (REPORT) {
    const out = path.join(__dirname, "..", "backups", `photo-backfill-${Date.now()}.csv`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const rows = ["id,productName,color,score,matchedOn,from,to"];
    for (const { product, match } of changes) {
      rows.push([
        product._id,
        JSON.stringify(product.productName || ""),
        JSON.stringify(product.color?.name || ""),
        match.score,
        match.matchedOn,
        product.imagePublicId || "",
        match.publicId,
      ].join(","));
    }
    fs.writeFileSync(out, rows.join("\n"));
    console.log(`\nevery row written to ${out}`);
  }

  if (!WRITE) {
    console.log("\nNothing written. Read the above, then re-run with --write.");
    return;
  }

  // The previous value of every field this touches, so a bad run is one
  // restore away rather than a git-history archaeology exercise.
  const undo = path.join(__dirname, "..", "backups", `photo-backfill-undo-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(undo), { recursive: true });
  fs.writeFileSync(undo, JSON.stringify(
    changes.map(({ product }) => ({ _id: product._id, imagePublicId: product.imagePublicId ?? null })),
    null, 1
  ));
  console.log(`\nundo file written to ${undo}`);

  const ops = changes.map(({ product, match }) => ({
    updateOne: {
      filter: { _id: product._id },
      update: { $set: { imagePublicId: match.publicId } },
    },
  }));

  if (!ops.length) { console.log("nothing to do"); return; }

  const result = await variations.bulkWrite(ops, { ordered: false });
  console.log(`products updated : ${result.modifiedCount}`);
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
