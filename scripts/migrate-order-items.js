// Chunk 6 of the order data-model migration: backfills items/shippingCents/
// taxCents/subtotalCents/totalCents onto existing orders, using the exact
// same convertLineItems() function checkout already uses for new orders —
// there is only one definition of "how a line_item becomes an item", shared
// by both paths.
//
// Already run once against upcell_development on 2026-09-04 (10 orders,
// all clean, all applied). Kept because the same migration will need to run
// again against the production database once it exists.
//
// Safe by construction:
//   - line_items is never touched, only read. Nothing is removed.
//   - Idempotent: an order that already has totalCents is skipped, so running
//     this twice (or after more orders have been created) does nothing extra.
//   - Defaults to DRY RUN — reports what would change, writes nothing.
//     Only runs for real with an explicit --apply flag.
//   - Flags every order whose recomputed total disagrees with what the order
//     already recorded (signedAmount, or a live line_items sum for older
//     orders) instead of silently writing a number that doesn't match.
//     Flagged orders are never written, dry run or apply, until a human
//     looks at them.
//
// Usage:
//   node scripts/migrate-order-items.js            (dry run, default)
//   node scripts/migrate-order-items.js --apply     (writes for real)
require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../src/models/order.model");
const { convertLineItems } = require("../src/utils/orderItems");

const APPLY = process.argv.includes("--apply");
const AMOUNT_TOLERANCE_CENTS = 1; // matches AMOUNT_TOLERANCE (0.01) elsewhere

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const dbName = mongoose.connection.db.databaseName;
  console.log(`Database: ${dbName}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}\n`);

  const candidates = await Order.find({ totalCents: { $exists: false } });
  console.log(`Orders without totalCents: ${candidates.length}\n`);

  let clean = 0;
  let flagged = 0;
  let noLineItems = 0;
  let applied = 0;

  for (const order of candidates) {
    if (!order.line_items || order.line_items.length === 0) {
      noLineItems++;
      continue;
    }

    const converted = convertLineItems(order.line_items);

    if (converted.unrecognized.length) {
      flagged++;
      console.log(
        `FLAGGED ${order._id} — unrecognised line(s): ${JSON.stringify(converted.unrecognized)}`
      );
      continue;
    }

    // Compare against whatever this order already trusted as its total —
    // signedAmount if it has one (BoA orders since today), otherwise a live
    // sum of totalPaid across line_items (every older order).
    const existingTotalDollars =
      order.signedAmount ??
      (order.line_items || []).reduce(
        (sum, item) => sum + (item?.price_data?.product_data?.metadata?.totalPaid || 0),
        0
      );
    const existingTotalCents = Math.round(existingTotalDollars * 100);
    const diff = Math.abs(existingTotalCents - converted.totalCents);

    if (diff > AMOUNT_TOLERANCE_CENTS) {
      flagged++;
      console.log(
        `FLAGGED ${order._id} — recomputed total ${converted.totalCents} disagrees with ` +
          `existing ${existingTotalCents} (diff ${diff} cents)`
      );
      continue;
    }

    clean++;
    if (!APPLY) {
      console.log(
        `OK ${order._id} — ${converted.items.length} item(s), totalCents ${converted.totalCents} ` +
          `(matches existing ${existingTotalCents})`
      );
      continue;
    }

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          items: converted.items,
          shippingCents: converted.shippingCents,
          taxCents: converted.taxCents,
          subtotalCents: converted.subtotalCents,
          totalCents: converted.totalCents,
          currency: order.currency || "USD",
        },
      }
    );
    applied++;
    console.log(`APPLIED ${order._id}`);
  }

  console.log("\n--- Summary ---");
  console.log(`Clean (recomputed total matches existing): ${clean}`);
  console.log(`Flagged (needs a human look, not touched):  ${flagged}`);
  console.log(`Skipped (no line_items at all):             ${noLineItems}`);
  if (APPLY) {
    console.log(`Applied (actually written):                 ${applied}`);
  } else {
    console.log(`\nDRY RUN — nothing was written. Re-run with --apply to write the ${clean} clean order(s).`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
