#!/usr/bin/env node
/**
 * Writes isAccessory: false onto the products that predate the field.
 *
 *   node scripts/backfill-is-accessory.js            dry run — prints, changes nothing
 *   node scripts/backfill-is-accessory.js --write    actually writes
 *
 * The public catalogue filters accessories out with { isAccessory: { $ne: true } },
 * which already treats a missing field and false the same way — so this changes
 * nothing a customer sees, and is safe to run at any time.
 *
 * What it changes is the shape of the data. 942 of 957 products have no such
 * field at all, so the index on it holds nothing useful for them, and any query
 * written as { isAccessory: false } — the obvious way to write it — silently
 * returns almost none of the catalogue. The field existing on every document is
 * what makes that query mean what it looks like it means.
 *
 * Only documents missing the field are touched. An accessory that was
 * deliberately marked true stays true.
 *
 * Safe to re-run: a second run finds nothing to do.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const variations = mongoose.connection.collection("singlevariations");

  const missing = await variations.countDocuments({ isAccessory: { $exists: false } });
  const alreadyFalse = await variations.countDocuments({ isAccessory: false });
  const accessories = await variations.countDocuments({ isAccessory: true });

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`missing the field : ${missing}`);
  console.log(`already false     : ${alreadyFalse}`);
  console.log(`accessories (true): ${accessories}   <- left alone`);

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written.");
    await mongoose.disconnect();
    return;
  }

  const result = await variations.updateMany(
    { isAccessory: { $exists: false } },
    { $set: { isAccessory: false } }
  );

  console.log(`\nWROTE changes — ${result.modifiedCount} products updated`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
