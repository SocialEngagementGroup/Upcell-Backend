#!/usr/bin/env node
/**
 * Removes return requests written before the v3 rewrite.
 *
 *   node scripts/clear-pre-v3-returns.js            dry run
 *   node scripts/clear-pre-v3-returns.js --write    apply
 *
 * The returns schema changed underneath these records. A v3 return carries the
 * window it was measured against and the grade the device sold at; both are
 * decided when the request is created and neither can be worked out later. A
 * request without them cannot be inspected — there is nothing to compare the
 * returned device against — so it sits in the queue looking live and fails at
 * the bench.
 *
 * Only requests missing BOTH are removed, and only ones raised by the team's
 * own addresses. A real customer's return is never test data, however broken
 * its shape, and the right answer for one of those is to repair it by hand.
 *
 * What this deliberately does not touch:
 *
 *   - The orders behind them. An order is the record of a payment, and the
 *     reconciliation job reads order history. One of them is left saying
 *     Refunded with no return behind it, which is untidy but true: the money
 *     did move during the test.
 *   - The products. Six are out of stock because they were sold in those test
 *     orders. Putting them back on sale is a change to the live shop, not a
 *     cleanup, so it is a separate decision.
 *   - The audit log. It is append-only on purpose; deleting the record of a
 *     deletion is the one thing an audit trail must not do.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");

// The team's own addresses. Anything else is treated as a real customer.
const TEAM = [
  "ash.uddin18@gmail.com",
  "devsunit83@gmail.com",
  "sunit@socialengagementgroup.com",
  "sunitsen50@gmail.com",
];

const isPreV3 = (doc) => !doc.window?.startDate && !doc.device?.gradeAtSale;

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  const all = await db.collection("refundrequests").find({}).toArray();

  const doomed = all.filter((doc) => isPreV3(doc) && TEAM.includes(doc.email));
  const keptBecauseCustomer = all.filter((doc) => isPreV3(doc) && !TEAM.includes(doc.email));
  const keptBecauseValid = all.filter((doc) => !isPreV3(doc));

  console.log(`Total returns          : ${all.length}`);
  console.log(`Pre-v3, team's own     : ${doomed.length}  <- to remove`);
  console.log(`Pre-v3, real customer  : ${keptBecauseCustomer.length}  <- kept, repair by hand`);
  console.log(`Complete v3 records    : ${keptBecauseValid.length}  <- kept\n`);

  for (const doc of doomed) {
    console.log(`  ${doc.rmaNumber || "(no rma)"}  ${doc.status.padEnd(16)} ${doc.email}`);
  }

  if (!doomed.length) {
    console.log("\nNothing to do.");
    await mongoose.disconnect();
    return;
  }

  if (!WRITE) {
    console.log("\nDry run — nothing was deleted.");
    await mongoose.disconnect();
    return;
  }

  // Written next to the script rather than into the database. If the call was
  // wrong, the answer is a re-insert from this file, and a copy that lives
  // only in a terminal scrollback is not a copy.
  const backup = path.join(__dirname, `removed-returns-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(backup, JSON.stringify(doomed, null, 2));
  console.log(`\nSaved a copy to ${backup}`);

  const result = await db.collection("refundrequests").deleteMany({
    _id: { $in: doomed.map((doc) => doc._id) },
  });

  console.log(`Removed ${result.deletedCount} of ${doomed.length}.`);
  console.log(`Remaining: ${await db.collection("refundrequests").countDocuments()}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
