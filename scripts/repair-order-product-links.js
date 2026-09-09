#!/usr/bin/env node
/**
 * Reconnects order lines whose productId points at a variant that no longer
 * exists.
 *
 *   node scripts/repair-order-product-links.js            dry run
 *   node scripts/repair-order-product-links.js --write    apply
 *
 * Saving a product used to delete every variant of the family and insert them
 * again, so each edit handed out new _ids and orphaned every order placed
 * before it. createProduct now matches variants on storage+colour and updates
 * them in place, so no new breakage is created — this repairs what already
 * happened.
 *
 * Nothing a customer sees is affected either way: an order stores its own
 * snapshot of the name, image and price paid. What breaks is the restock —
 * returning or refunding maps the line's productId back to a variation to put
 * the stock back (services/inventory.js), and an id matching nothing puts
 * nothing back, silently.
 *
 * Matching is deliberately conservative. A line is only repaired when exactly
 * one live variant matches its stored name AND unit price. Anything ambiguous
 * is reported and left alone, because pointing an order at the wrong device is
 * worse than leaving it pointing at nothing.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const Orders = db.collection("orders");
  const Variations = db.collection("singlevariations");

  const orders = await Orders.find({ "items.0": { $exists: true } }).toArray();

  let lines = 0, live = 0, repaired = 0, ambiguous = 0, unmatched = 0;
  const updates = [];

  for (const order of orders) {
    const items = order.items || [];
    let changed = false;

    for (const item of items) {
      lines += 1;

      if (item.productId && (await Variations.countDocuments({ _id: item.productId }))) {
        live += 1;
        continue;
      }

      // Same product name and same price per unit, then narrowed by the
      // line's own description — it reads "Light Gold Good 256GB", so it
      // carries the colour and storage that separate four otherwise identical
      // candidates from each other.
      let candidates = await Variations
        .find({ productName: item.name, price: item.unitPriceCents / 100 })
        .project({ _id: 1, storage: 1, "color.name": 1 })
        .toArray();

      if (candidates.length > 1) {
        const description = String(item.description || "").toLowerCase();
        const narrowed = candidates.filter((variant) => {
          const storage = String(variant.storage || "").toLowerCase();
          const colour = String(variant.color?.name || "").toLowerCase();
          return storage && colour
            && description.includes(storage)
            && description.includes(colour);
        });
        if (narrowed.length) candidates = narrowed;
      }

      if (candidates.length === 1) {
        repaired += 1;
        changed = true;
        item.productId = candidates[0]._id;
        console.log(`  repair  order ...${String(order._id).slice(-6)}  "${item.name}" -> ${candidates[0].storage} ${candidates[0].color?.name || ""}`);
      } else if (candidates.length > 1) {
        ambiguous += 1;
        console.log(`  SKIP    order ...${String(order._id).slice(-6)}  "${item.name}" matches ${candidates.length} variants — left alone`);
      } else {
        unmatched += 1;
        console.log(`  SKIP    order ...${String(order._id).slice(-6)}  "${item.name}" has no live match — product was deleted`);
      }
    }

    if (changed) updates.push({ _id: order._id, items });
  }

  console.log(`\n${WRITE ? "MODE: WRITE" : "MODE: DRY RUN (use --write to apply)"}`);
  console.log(`  order lines        : ${lines}`);
  console.log(`  already fine       : ${live}`);
  console.log(`  can be repaired    : ${repaired}`);
  console.log(`  ambiguous, skipped : ${ambiguous}`);
  console.log(`  no match, skipped  : ${unmatched}`);

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written.");
    await mongoose.disconnect();
    return;
  }

  for (const update of updates) {
    await Orders.updateOne({ _id: update._id }, { $set: { items: update.items } });
  }

  console.log(`\nWROTE changes — ${updates.length} orders updated`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
