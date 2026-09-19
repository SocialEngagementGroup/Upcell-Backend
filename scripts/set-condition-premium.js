#!/usr/bin/env node
/**
 * One condition for the whole catalogue.
 *
 *   node scripts/set-condition-premium.js            dry run
 *   node scripts/set-condition-premium.js --write    apply
 *
 * The client's decision, 19 September 2026: every device UpCell sells is
 * Premium. There are no grades for a customer to compare, on the shop or
 * anywhere else.
 *
 * This replaces migrate-condition-to-grade.js, which is now the wrong job. That
 * script mapped the catalogue onto the returns scale — Mint and New to
 * EXCELLENT, Good to GOOD — so a customer could be shown one of three grades.
 * With one condition there is nothing to map to. Do not run both.
 *
 * The original value is copied to `conditionLegacy` before being overwritten,
 * the same way migrate-condition-to-grade.js kept it. Production held Excellent
 * 480, Good 220 and Mint 254, and that is a fact about the stock on the shelves
 * whatever the shop decides to print. A decision like this can be reversed; a
 * column that has been flattened cannot.
 *
 * Safe to re-run: a product already reading Premium is skipped, and
 * conditionLegacy is only written where it does not already exist — so running
 * this twice cannot overwrite the original with "Premium".
 */
require("dotenv").config();
require("./lib/announce-db");
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");
const PREMIUM = "Premium";

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
  const variations = mongoose.connection.collection("singlevariations");

  const docs = await variations
    .find({}, { projection: { condition: 1, conditionLegacy: 1 } })
    .toArray();

  const already = docs.filter((doc) => doc.condition === PREMIUM);
  const toChange = docs.filter((doc) => doc.condition !== PREMIUM);

  const byValue = {};
  for (const doc of toChange) {
    const key = doc.condition === undefined ? "(none)" : String(doc.condition);
    byValue[key] = (byValue[key] || 0) + 1;
  }

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`products             : ${docs.length}`);
  console.log(`already Premium      : ${already.length}`);
  console.log(`to set               : ${toChange.length}`);
  console.log("\ncurrent values being replaced:");
  for (const [value, count] of Object.entries(byValue).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${value.padEnd(16)} ${String(count).padStart(4)}  ->  ${PREMIUM}`);
  }

  const needLegacy = toChange.filter(
    (doc) => doc.conditionLegacy === undefined && doc.condition !== undefined
  );
  console.log(`\noriginal kept in conditionLegacy for ${needLegacy.length} of them`);
  console.log(
    `${toChange.length - needLegacy.length} already carry a conditionLegacy, or had no condition to keep`
  );

  if (!WRITE) {
    console.log("\nNothing written. Re-run with --write to apply.");
    return;
  }

  // Two passes rather than one, because they answer different questions and
  // must not overwrite each other. The first preserves originals only where
  // nothing is preserved yet; the second sets the new value everywhere. Done
  // the other way round, a re-run would copy "Premium" into conditionLegacy
  // and the original would be gone.
  let kept = 0;
  for (const doc of needLegacy) {
    const result = await variations.updateOne(
      { _id: doc._id, conditionLegacy: { $exists: false } },
      { $set: { conditionLegacy: doc.condition } }
    );
    kept += result.modifiedCount;
  }

  const set = await variations.updateMany(
    { condition: { $ne: PREMIUM } },
    { $set: { condition: PREMIUM } }
  );

  console.log(`\noriginals kept  : ${kept}`);
  console.log(`conditions set  : ${set.modifiedCount}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
