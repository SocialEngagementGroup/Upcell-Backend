#!/usr/bin/env node
/**
 * Moves the six old trade-in statuses onto the state machine.
 *
 *   node scripts/migrate-trade-in-status.js            dry run
 *   node scripts/migrate-trade-in-status.js --write    apply
 *
 * Five of the six map straight across (see LEGACY_STATUS_MAP in
 * constants/tradeInStatus.js). The sixth is the problem.
 *
 * The old "Quoted" meant two different things and the record does not say
 * which: a price offered before the device arrived, and a price revised after
 * somebody looked at it. Those are now Quoted and RevisedOffer, and they are
 * not interchangeable — RevisedOffer stops the payout clock and gives the
 * customer five days to answer, so filing a fresh quote there would put a
 * deadline on a customer who was never told about one.
 *
 * It is decided from the estimate instead. A request whose stored estimate no
 * longer matches what the quote breakdown came to is one somebody changed by
 * hand after inspection, which is a revised offer. One where they agree is a
 * quote nobody has touched. Where there is no breakdown to compare against,
 * the safe answer is Quoted: a customer with an open quote and no deadline is
 * a conversation, and a customer with a deadline they were never told about
 * is a complaint.
 *
 * Every converted request gets a timeline entry saying the migration did it,
 * so nothing in the log looks like a decision a person made.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { TradeInRequest } = require("../src/models/tradeInRequest.model");
const { LEGACY_STATUS_MAP, isTradeInStatus } = require("../src/constants/tradeInStatus");

const WRITE = process.argv.includes("--write");

/**
 * What one old request becomes.
 *
 * Exported and pure so the decision can be tested against records without a
 * database — this runs once against real customer data and there is no
 * second chance at it.
 */
function targetStatus(request) {
  const legacy = request?.status;

  // Already migrated, or written after the machine existed.
  if (isTradeInStatus(legacy) && !Object.prototype.hasOwnProperty.call(LEGACY_STATUS_MAP, legacy)) {
    return { status: legacy, changed: false, why: "already on the state machine" };
  }

  if (legacy !== "Quoted") {
    const mapped = LEGACY_STATUS_MAP[legacy];
    if (!mapped) return { status: null, changed: false, why: `unknown status "${legacy}"` };
    return { status: mapped, changed: mapped !== legacy, why: "direct mapping" };
  }

  // The ambiguous one.
  const quoted = lastBreakdownCents(request);

  if (quoted == null) {
    return { status: "Quoted", changed: false, why: "no breakdown to compare — treated as an open quote" };
  }

  const stored = storedCents(request);
  if (stored == null) {
    return { status: "Quoted", changed: false, why: "no stored estimate — treated as an open quote" };
  }

  // A dollar of slack. The old records stored dollars and the breakdown
  // stores cents, and a rounding difference is not somebody revising a price.
  if (Math.abs(stored - quoted) <= 100) {
    return { status: "Quoted", changed: false, why: "estimate matches the quote" };
  }

  return {
    status: "RevisedOffer",
    changed: true,
    why: `estimate ${stored}c differs from the quote ${quoted}c`,
  };
}

const lastBreakdownCents = (request) => {
  const steps = request?.quoteBreakdown;
  if (!Array.isArray(steps) || !steps.length) return null;
  const last = steps[steps.length - 1];
  return Number.isFinite(last?.resultCents) ? last.resultCents : null;
};

const storedCents = (request) => {
  if (Number.isFinite(request?.estimateCents)) return request.estimateCents;
  if (Number.isFinite(request?.estimate)) return Math.round(request.estimate * 100);
  return null;
};

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(WRITE ? "WRITING\n" : "DRY RUN — nothing will be saved\n");

  const legacyValues = Object.keys(LEGACY_STATUS_MAP);
  const requests = await TradeInRequest.find({ status: { $in: legacyValues } });

  const counts = {};
  const unknown = [];
  let changed = 0;

  for (const request of requests) {
    const result = targetStatus(request);

    if (!result.status) {
      unknown.push({ id: String(request._id), status: request.status });
      continue;
    }

    const key = `${request.status} -> ${result.status}`;
    counts[key] = (counts[key] || 0) + 1;

    if (result.status === request.status) continue;
    changed += 1;

    console.log(`  ${String(request._id)}  ${key}  (${result.why})`);

    if (!WRITE) continue;

    const from = request.status;
    request.status = result.status;
    if (!Array.isArray(request.timeline)) request.timeline = [];
    // Attributed to the migration, so nothing in the log reads as a decision
    // somebody made.
    request.timeline.push({
      at: new Date(),
      actor: "system",
      actorType: "system",
      event: "status_migrated",
      from,
      to: result.status,
      meta: { why: result.why, script: "migrate-trade-in-status" },
    });
    await request.save();
  }

  console.log("\nBy mapping:");
  Object.entries(counts).forEach(([key, count]) => console.log(`  ${count.toString().padStart(5)}  ${key}`));

  console.log(`\n${requests.length} on an old status, ${changed} would change.`);

  if (unknown.length) {
    console.log(`\n${unknown.length} with a status nothing maps — left alone:`);
    unknown.slice(0, 20).forEach((row) => console.log(`  ${row.id}  "${row.status}"`));
  }

  if (!WRITE && changed) console.log("\nRe-run with --write to apply.");

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { targetStatus };
