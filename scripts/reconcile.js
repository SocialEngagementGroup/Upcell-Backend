// Run the payment check by hand: npm run reconcile
//
// Useful when the host has been asleep, or to check a specific period after
// the fact. Exits non-zero when something critical is found, so it can also be
// wired into an external scheduler later without changes.
require("dotenv").config();

const mongoose = require("mongoose");
const { connectToDb } = require("../src/config/database");
const { runReconciliation } = require("../src/services/reconciliation");

const hours = Number(process.argv[2]) || 24;

(async () => {
  await connectToDb();

  const report = await runReconciliation({ windowMs: hours * 60 * 60 * 1000 });

  console.log(`\nPayment check — last ${report.windowHours}h`);
  console.log("=".repeat(48));

  const section = (label, items) => {
    if (!items.length) return;
    console.log(`\n${label} (${items.length})`);
    items.forEach((line) => console.log("  - " + line));
  };

  section("CRITICAL", report.critical);
  section("WARNING", report.warnings);
  section("INFO", report.info);

  if (report.clean) console.log("\nNothing to report. All payment records agree.");

  await mongoose.disconnect();
  process.exit(report.critical.length ? 1 : 0);
})().catch((error) => {
  console.error("Payment check failed:", error);
  process.exit(2);
});
