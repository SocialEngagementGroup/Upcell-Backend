#!/usr/bin/env node
/**
 * Seeds the trade-in price book and question set.
 *
 *   node scripts/seed-trade-in-pricebook.js            dry run
 *   node scripts/seed-trade-in-pricebook.js --write    apply
 *
 * Every number here is copied from Frontend/src/pages/TradeIn/TradeIn.jsx as
 * it stood on 11 September 2026 — basePrices, storageMultiplier, and the
 * deductions inside calculateEstimate. Copied rather than imported, on
 * purpose: importing across the repo boundary would tie a backend migration to
 * a frontend file, and the whole point of this move is that the frontend stops
 * being the source of these numbers.
 *
 * The multipliers were spread across an if-chain in calculateEstimate:
 *
 *     powersOn === false   -> price * 0.15, and stop
 *     functional === false -> price * 0.55
 *     cracked === false    -> price * 0.50
 *     screenCondition good -> price * 0.90     fair -> 0.75
 *     bodyCondition  good  -> price * 0.92     fair -> 0.80
 *
 * "flawless" appears in neither branch, so it multiplied by nothing — recorded
 * here as an explicit 1.0, which is the same arithmetic said out loud.
 *
 * Yasir's real prices replace these through the admin screen. This is the
 * starting point, not the answer.
 *
 * Safe to re-run: a model already in the book is left alone unless --force is
 * given, so a re-run cannot overwrite a price somebody has since edited.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const TradeInPriceBook = require("../src/models/tradeInPriceBook.model");
const TradeInQuestion = require("../src/models/tradeInQuestion.model");

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------- prices
// Verbatim from basePrices, in dollars. Converted to cents on write.
const BASE_PRICES = {
  iphone16promax: 820, iphone16pro: 720, iphone16plus: 580, iphone16: 510,
  iphone15promax: 680, iphone15pro: 590, iphone15plus: 470, iphone15: 400,
  iphone14promax: 520, iphone14pro: 440, iphone14: 310,
  iphone13pro: 360, iphone13: 250, iphone12pro: 270, iphone12: 190, iphone11: 120,
  ipadprom4: 680, ipadpro12: 520, ipadpro11: 430, ipadairm2: 400,
  ipadair5: 320, ipadmini6: 260, ipad10: 210, ipad9: 140,
  mbp16m3: 1250, mbp14m3: 1050, mbp16m2: 980, mbp14m2: 820,
  mba15m3: 780, mba13m3: 650, mba15m2: 620, mba13m2: 520,
  s25ultra: 850, s25plus: 620, s25: 520,
  s24ultra: 700, s24plus: 520, s24: 440,
  s23ultra: 540, s23plus: 380, s23: 320,
  s22ultra: 360,
  pixel9proxl: 720, pixel9pro: 620, pixel9: 480, pixel9a: 340,
  pixel8pro: 480, pixel8: 360, pixel8a: 280,
};

// Verbatim from storageMultiplier.
const STORAGE = { "64GB": 0.85, "128GB": 1.0, "256GB": 1.12, "512GB": 1.25, "1TB": 1.45, "2TB": 1.65 };

// calculateEstimate never looked at carrier. Every value is 1.0 so the
// migration changes nobody's number; the map exists so that can change later
// without a release.
const CARRIERS = {
  iPhone: { unlocked: 1.0, att: 1.0, tmobile: 1.0, verizon: 1.0 },
  iPad: { wifi: 1.0, wifi_cellular: 1.0 },
  MacBook: {},
  Samsung: { unlocked: 1.0, att: 1.0, tmobile: 1.0, verizon: 1.0 },
  Google: { unlocked: 1.0, att: 1.0, tmobile: 1.0, verizon: 1.0 },
};

const deviceTypeFor = (modelKey) => {
  if (modelKey.startsWith("iphone")) return "iPhone";
  if (modelKey.startsWith("ipad")) return "iPad";
  if (modelKey.startsWith("mb")) return "MacBook";
  if (modelKey.startsWith("s2")) return "Samsung";
  if (modelKey.startsWith("pixel")) return "Google";
  return null;
};

// Only for the seed. Staff rename these in the admin screen; nothing reads
// them but the page.
const displayNameFor = (modelKey) => modelKey
  .replace(/^iphone/, "iPhone ")
  .replace(/^ipadpro/, "iPad Pro ")
  .replace(/^ipadair/, "iPad Air ")
  .replace(/^ipadmini/, "iPad mini ")
  .replace(/^ipad/, "iPad ")
  .replace(/^mbp/, "MacBook Pro ")
  .replace(/^mba/, "MacBook Air ")
  .replace(/^s(\d)/, "Galaxy S$1 ")
  .replace(/^pixel/, "Pixel ")
  .replace(/promax$/, "Pro Max")
  .replace(/pro$/, "Pro")
  .replace(/plus$/, "Plus")
  .replace(/ultra$/, "Ultra")
  .trim();

// ------------------------------------------------------------- questions
const SCREEN_OPTIONS = [
  { id: "flawless", title: "Flawless", desc: "No visible scratches or marks on the display.", multiplier: 1.0 },
  { id: "good", title: "Good", desc: "Minor scratches only visible when screen is off.", multiplier: 0.9 },
  { id: "fair", title: "Fair", desc: "Noticeable scratches visible during regular use.", multiplier: 0.75 },
];

const BODY_OPTIONS = [
  { id: "flawless", title: "Like New", desc: "No visible wear on the frame or back glass.", multiplier: 1.0 },
  { id: "good", title: "Good", desc: "Minor cosmetic marks that don't affect function.", multiplier: 0.92 },
  { id: "fair", title: "Fair", desc: "Noticeable dents, scratches, or marks on the body.", multiplier: 0.8 },
];

const POWERS_ON = {
  id: "powersOn",
  question: "Does the device power on and hold a charge?",
  type: "boolean",
  noMultiplier: 0.15,
  // Every question after this asks about something nobody can check on a
  // device that will not switch on. calculateEstimate returned here too.
  terminal: true,
};

const FUNCTIONAL = {
  id: "functional",
  question: "Is the device fully functional?",
  subtitle: "All buttons, touch, Face ID, cameras, and speakers work normally.",
  type: "boolean",
  noMultiplier: 0.55,
};

const CRACKED = {
  id: "cracked",
  question: "Are the front and back glass free of cracks?",
  type: "boolean",
  noMultiplier: 0.5,
};

const QUESTIONS = {
  iPhone: [POWERS_ON, FUNCTIONAL, CRACKED,
    { id: "screenCondition", question: "What best describes the screen condition?", type: "choice", options: SCREEN_OPTIONS },
    { id: "bodyCondition", question: "What best describes the body condition?", type: "choice", options: BODY_OPTIONS }],
  iPad: [POWERS_ON,
    { ...FUNCTIONAL, subtitle: "Touch, cameras, buttons, and speakers all work properly." },
    { ...CRACKED, question: "Is the screen free of cracks?" },
    { id: "screenCondition", question: "What best describes the screen condition?", type: "choice", options: SCREEN_OPTIONS }],
  MacBook: [
    { ...POWERS_ON, question: "Does the MacBook power on and hold a charge?" },
    { ...FUNCTIONAL, question: "Is the MacBook fully functional?", subtitle: "Keyboard, trackpad, display, ports, and speakers all work properly." },
    { id: "screenCondition", question: "What best describes the overall condition?", type: "choice", options: SCREEN_OPTIONS }],
  Samsung: [POWERS_ON, FUNCTIONAL, CRACKED,
    { id: "screenCondition", question: "What best describes the screen condition?", type: "choice", options: SCREEN_OPTIONS },
    { id: "bodyCondition", question: "What best describes the body condition?", type: "choice", options: BODY_OPTIONS }],
  Google: [POWERS_ON, FUNCTIONAL, CRACKED,
    { id: "screenCondition", question: "What best describes the screen condition?", type: "choice", options: SCREEN_OPTIONS },
    { id: "bodyCondition", question: "What best describes the body condition?", type: "choice", options: BODY_OPTIONS }],
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");

  const existing = new Set(
    (await TradeInPriceBook.find({}).select("modelKey").lean()).map((row) => row.modelKey)
  );

  let created = 0;
  let skipped = 0;
  let unmapped = 0;

  for (const [modelKey, dollars] of Object.entries(BASE_PRICES)) {
    const deviceType = deviceTypeFor(modelKey);

    if (!deviceType) {
      console.log(`  ${modelKey.padEnd(16)} UNMAPPED — no device type`);
      unmapped += 1;
      continue;
    }

    if (existing.has(modelKey) && !FORCE) {
      skipped += 1;
      continue;
    }

    created += 1;
    if (!WRITE) continue;

    await TradeInPriceBook.updateOne(
      { modelKey },
      {
        $set: {
          modelKey,
          deviceType,
          brand: deviceType === "Samsung" ? "Samsung" : deviceType === "Google" ? "Google" : "Apple",
          displayName: displayNameFor(modelKey),
          basePriceCents: Math.round(dollars * 100),
          storageMultipliers: STORAGE,
          carrierAdjustments: CARRIERS[deviceType] || {},
          active: true,
          updatedBy: "seed",
        },
        $setOnInsert: { priceBookVersion: 1 },
      },
      { upsert: true }
    );
  }

  console.log(`\nModels: ${Object.keys(BASE_PRICES).length}`);
  console.log(`  to write : ${created}`);
  console.log(`  untouched: ${skipped}${skipped && !FORCE ? "  (already in the book — --force to overwrite)" : ""}`);
  console.log(`  unmapped : ${unmapped}`);

  console.log("\nQuestion sets:");
  for (const [deviceType, questions] of Object.entries(QUESTIONS)) {
    console.log(`  ${deviceType.padEnd(10)} ${questions.length} questions`);
    if (!WRITE) continue;

    await TradeInQuestion.updateOne(
      { deviceType },
      { $set: { deviceType, questions, updatedBy: "seed" }, $setOnInsert: { priceBookVersion: 1 } },
      { upsert: true }
    );
  }

  if (!WRITE) console.log("\nDry run — nothing was written.");

  await mongoose.disconnect();
}

// Only when run as a script. The tables below are also imported by
// tests/tradeInPricing.test.js, which compares them against the arithmetic the
// browser used — and requiring this file must not open a database connection
// or print a report.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { BASE_PRICES, STORAGE, QUESTIONS, CARRIERS, deviceTypeFor };
