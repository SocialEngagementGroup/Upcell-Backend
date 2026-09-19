#!/usr/bin/env node
/**
 * Retires the Stripe/PayPal era from the order and payment-log collections.
 *
 *   node scripts/fix-legacy-gateway-rows.js            dry run
 *   node scripts/fix-legacy-gateway-rows.js --write    apply
 *
 * Two problems, deliberately handled differently.
 *
 * ORDERS — repaired, not deleted. Six orders carry paidWith "Stripe" or
 * "Paypal", neither of which is in paidWithEnum any more. That is not cosmetic:
 * order.controller.js updates orders with .save(), which runs validators, so
 * shipping, refunding or changing the status of one of these answers 500. They
 * become "Card", which is in the enum and is what they actually were — a card
 * payment taken through a gateway UpCell no longer uses. The original value is
 * kept in legacyPaidWith so the history is not invented away.
 *
 * PAYMENT LOGS — deleted. gatewayEnum is ["BankOfAmerica"] alone, so these rows
 * cannot be written by any current code path and describe a gateway that has
 * been removed. Checked before writing this: reconciliation.js only ever reads
 * logs for BankOfAmerica orders in a 24-hour window, so nothing reads these.
 * They are exported to a JSON file first, because "test data" is a judgement
 * and an export costs nothing.
 */
require("dotenv").config();
require("./lib/announce-db");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");
const LIVE_GATEWAY = "BankOfAmerica";
const REPLACEMENT = "Card";

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
  const orders = mongoose.connection.collection("orders");
  const logs = mongoose.connection.collection("paymenteventlogs");

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  // ---- orders ----------------------------------------------------------
  const badOrders = await orders.find({ paidWith: { $nin: ["Card", "Manual", LIVE_GATEWAY] } }).toArray();
  console.log(`orders with a retired paidWith : ${badOrders.length}`);
  for (const o of badOrders) {
    console.log(`   ${o._id}  ${String(o.email || "(no email)").padEnd(32)} ${o.paidWith} -> ${REPLACEMENT}   [${o.status}]`);
  }

  // ---- payment logs ----------------------------------------------------
  const deadLogs = await logs.find({ gateway: { $ne: LIVE_GATEWAY } }).toArray();
  const keptLogs = await logs.countDocuments({ gateway: LIVE_GATEWAY });
  console.log(`\npayment logs to delete         : ${deadLogs.length}   (keeping ${keptLogs} BankOfAmerica)`);
  for (const l of deadLogs) {
    console.log(`   ${l._id}  ${String(l.gateway).padEnd(8)} ${String(l.eventType).padEnd(18)} order:${l.orderId || "none"}`);
  }

  if (!WRITE) {
    console.log("\nNothing written. Re-run with --write to apply.");
    return;
  }

  // Export before deleting. Recovering from a file is easy; recovering from a
  // decision made at 9pm is not.
  if (deadLogs.length) {
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `deleted-payment-logs-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(deadLogs, null, 2));
    console.log(`\nexported deleted logs -> ${file}`);
  }

  let repaired = 0;
  for (const o of badOrders) {
    const res = await orders.updateOne(
      { _id: o._id },
      { $set: { paidWith: REPLACEMENT, legacyPaidWith: o.paidWith } }
    );
    repaired += res.modifiedCount;
  }

  const removed = deadLogs.length
    ? (await logs.deleteMany({ _id: { $in: deadLogs.map((l) => l._id) } })).deletedCount
    : 0;

  console.log(`\norders repaired : ${repaired}`);
  console.log(`logs deleted    : ${removed}`);
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
