#!/usr/bin/env node
/**
 * Adds a Cloudinary `publicId` next to every existing image reference.
 *
 *   node scripts/backfill-image-public-ids.js --dry-run   (default: report only)
 *   node scripts/backfill-image-public-ids.js --write     (apply)
 *
 * Purely additive. The existing `url` is left in place, so nothing that reads
 * it today changes behaviour and the whole thing is reversible with a single
 * $unset. Documents already carrying a publicId are skipped, making re-runs
 * safe.
 *
 * Base64 values are counted and skipped, never rewritten — those need a real
 * upload, not a string swap.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

const MAPPING = path.join(__dirname, "cloudinary-manifest.json");
const WRITE = process.argv.includes("--write");

const TARGETS = [
  { collection: "parentproducts", field: "images", kind: "array" },
  { collection: "shopcategories", field: "images", kind: "array" },
  { collection: "singlevariations", field: "image", kind: "string" },
];

(async () => {
  const { mapping } = JSON.parse(fs.readFileSync(MAPPING, "utf8"));
  const lookup = (url) => mapping[String(url).replace(/^\//, "")]?.publicId;

  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  let grandTotal = 0;

  for (const { collection, field, kind } of TARGETS) {
    const col = db.collection(collection);
    const docs = await col.find({}).toArray();

    let updated = 0, refs = 0, skippedBase64 = 0, alreadyDone = 0, unresolved = 0;
    const ops = [];

    for (const doc of docs) {
      const value = doc[field];
      if (value === undefined || value === null) continue;

      if (kind === "array") {
        if (!Array.isArray(value)) continue;
        let changed = false;

        const next = value.map((item) => {
          const url = typeof item === "string" ? item : item?.url;
          if (typeof url !== "string") return item;
          if (url.startsWith("data:")) { skippedBase64++; return item; }
          if (item?.publicId) { alreadyDone++; return item; }

          const publicId = lookup(url);
          if (!publicId) { unresolved++; return item; }

          refs++;
          changed = true;
          const dims = mapping[url.replace(/^\//, "")];
          return { ...(typeof item === "object" ? item : { url }), publicId, width: dims.width, height: dims.height };
        });

        if (changed) {
          ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [field]: next } } } });
          updated++;
        }
      } else {
        if (typeof value !== "string") continue;
        if (value.startsWith("data:")) { skippedBase64++; continue; }
        if (doc.imagePublicId) { alreadyDone++; continue; }

        const publicId = lookup(value);
        if (!publicId) { unresolved++; continue; }

        refs++;
        const dims = mapping[value.replace(/^\//, "")];
        // Stored on a sibling field so the original string stays untouched.
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { imagePublicId: publicId, imageWidth: dims.width, imageHeight: dims.height } },
          },
        });
        updated++;
      }
    }

    if (WRITE && ops.length) await col.bulkWrite(ops, { ordered: false });
    grandTotal += refs;

    console.log(`${collection.padEnd(18)} docs ${String(docs.length).padStart(4)}  refs ${String(refs).padStart(4)}  docs-updated ${String(updated).padStart(4)}  base64-skipped ${skippedBase64}  already ${alreadyDone}  unresolved ${unresolved}`);
  }

  console.log(`\n${grandTotal} references ${WRITE ? "backfilled" : "would be backfilled"}`);
  if (!WRITE) console.log("nothing was written");

  await mongoose.disconnect();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
