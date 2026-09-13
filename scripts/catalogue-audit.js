#!/usr/bin/env node
/**
 * What the catalogue is missing, and what the client has to fill in.
 *
 *   node scripts/catalogue-audit.js              print the summary
 *   node scripts/catalogue-audit.js --csv        also write the two CSV files
 *
 * Read-only. It never writes to the database.
 *
 * Two jobs in one pass, because they read the same rows:
 *
 * 1. **The audit** — what is missing, what looks wrong, and what is priced in
 *    a way somebody should look at. Printed to the terminal.
 * 2. **The sheet** — every product with every field UpCell holds, as a CSV the
 *    client can open in Google Sheets and fill in. The blanks are the work.
 *
 * On pricing: this cannot know what a device is worth, so it never says "wrong
 * price". It says "worth a look", and it says why — a price of zero, a
 * discount above the list price, or a unit priced far from the other units of
 * the same model and storage. The last one is the useful one: four iPhone 13
 * 128GB at $499 and one at $79 is either a typo or a device with something
 * wrong with it, and only a person knows which.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const SingleVariation = require("../src/models/singleVariation.model");
const ParentProduct = require("../src/models/parentProduct.model");

const WRITE_CSV = process.argv.includes("--csv");
const OUT_DIR = path.join(__dirname, "..", "reports");

// A price this far from the median of its own model+storage group is worth a
// human look. Half or double is wide on purpose: used devices genuinely vary
// by condition, and a narrow band would flag the whole catalogue.
const PRICE_OUTLIER_LOW = 0.5;
const PRICE_OUTLIER_HIGH = 2.0;

// Groups smaller than this have no meaningful median — two units priced $499
// and $79 are not an outlier and a typo, they are two facts.
const MIN_GROUP_FOR_OUTLIER = 3;

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const blank = (value) =>
  value === null || value === undefined || String(value).trim() === "";

/** The colour field is sometimes a string and sometimes { name, hex }. */
const colourOf = (product) => {
  const c = product.color;
  if (!c) return "";
  if (typeof c === "string") return c;
  return c.name || c.title || c.label || "";
};

const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Quoted whenever it holds a separator, a quote or a newline; quotes inside
  // are doubled. Getting this wrong shifts every column after it by one.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const toCsv = (rows, columns) =>
  [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\n");

async function main() {
  if (!process.env.MONGODB_URL) {
    console.error("MONGODB_URL is not set.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URL);

  const [variants, parents] = await Promise.all([
    SingleVariation.find({}).lean(),
    ParentProduct.find({}).select("_id modelName categoryName images slug").lean(),
  ]);

  const parentById = new Map(parents.map((p) => [String(p._id), p]));

  const devices = variants.filter((v) => !v.isAccessory);
  const accessories = variants.filter((v) => v.isAccessory);

  // --- price groups, for the outlier check -------------------------------
  const groups = new Map();
  devices.forEach((d) => {
    if (!Number.isFinite(d.price) || d.price <= 0) return;
    const key = `${d.productName || "?"}|${d.storage || "?"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d.price);
  });

  const groupMedian = new Map();
  groups.forEach((prices, key) => {
    if (prices.length >= MIN_GROUP_FOR_OUTLIER) groupMedian.set(key, median(prices));
  });

  // How many units the outlier check actually covers.
  //
  // Reported because "0 outliers" is worth nothing without it: if every
  // model+storage held one unit, no group would qualify, the check would never
  // run, and zero would look like a clean bill of health.
  const outlierCoverage = [...groups.values()]
    .filter((prices) => prices.length >= MIN_GROUP_FOR_OUTLIER)
    .reduce((sum, prices) => sum + prices.length, 0);

  // The question that matters more for a used-device shop: does condition
  // change the price at all?
  //
  // A Good phone and an Excellent one at the same money means one of the two is
  // wrong — the Excellent is underpriced or the Good will not sell. This is not
  // a typo the code can spot; it is a decision nobody has made.
  const byModelStorage = new Map();
  devices.forEach((d) => {
    const key = `${d.productName || "?"}|${d.storage || "?"}`;
    if (!byModelStorage.has(key)) byModelStorage.set(key, []);
    byModelStorage.get(key).push(d);
  });

  const gradeNotPriced = [];
  byModelStorage.forEach((units, key) => {
    const grades = new Set(units.map((u) => u.cosmeticGrade).filter(Boolean));
    const prices = new Set(units.map((u) => u.price).filter((p) => Number.isFinite(p)));
    if (grades.size > 1 && prices.size === 1) {
      gradeNotPriced.push({
        group: key,
        grades: [...grades].sort().join(" and "),
        price: [...prices][0],
        units: units.length,
      });
    }
  });

  // --- per-row assessment -------------------------------------------------
  const rows = [];
  const issues = {
    noImage: [], genericImage: [], noPrice: [], noStorage: [], noColour: [],
    noGrade: [], noBattery: [], noCarrier: [], noDeviceType: [], noIdentity: [],
    noDescription: [], orphaned: [], badDiscount: [], priceOutlier: [], noSlug: [],
  };

  const note = (bucket, product, detail) => {
    issues[bucket].push({
      id: String(product._id),
      name: product.productName || "(no name)",
      storage: product.storage || "",
      price: product.price,
      detail: detail || "",
    });
  };

  variants.forEach((v) => {
    const parent = parentById.get(String(v.parentCatagory));
    const isDevice = !v.isAccessory;
    const needs = [];

    if (blank(v.image)) { note("noImage", v); needs.push("photo"); }
    else if (v.imageIsGeneric) { note("genericImage", v); needs.push("real photo"); }

    if (!Number.isFinite(v.price) || v.price <= 0) { note("noPrice", v); needs.push("price"); }

    if (isDevice) {
      if (blank(v.storage)) { note("noStorage", v); needs.push("storage"); }
      if (blank(colourOf(v))) { note("noColour", v); needs.push("colour"); }
      if (blank(v.cosmeticGrade)) { note("noGrade", v); needs.push("grade"); }
      if (!Number.isFinite(v.batteryHealth)) { note("noBattery", v); needs.push("battery %"); }
      if (blank(v.carrierStatus)) { note("noCarrier", v); needs.push("carrier"); }
      if (blank(v.deviceType)) { note("noDeviceType", v); needs.push("device type"); }
      if (blank(v.imei) && blank(v.serialNumber)) { note("noIdentity", v); needs.push("IMEI or serial"); }
    }

    if (blank(v.description)) { note("noDescription", v); needs.push("description"); }
    if (blank(v.slug)) note("noSlug", v);
    if (!parent) note("orphaned", v, `parentCatagory ${v.parentCatagory} not found`);

    // A discount above the price it discounts is always a mistake.
    if (Number.isFinite(v.discountPrice) && Number.isFinite(v.price) && v.discountPrice > v.price) {
      note("badDiscount", v, `discount $${v.discountPrice} above price $${v.price}`);
      needs.push("check discount");
    }

    let outlier = "";
    const key = `${v.productName || "?"}|${v.storage || "?"}`;
    const mid = groupMedian.get(key);
    if (isDevice && mid && Number.isFinite(v.price) && v.price > 0) {
      if (v.price < mid * PRICE_OUTLIER_LOW || v.price > mid * PRICE_OUTLIER_HIGH) {
        outlier = `$${v.price} vs $${mid} typical for this model+storage`;
        note("priceOutlier", v, outlier);
        needs.push("check price");
      }
    }

    rows.push({
      "Product ID": String(v._id),
      "Category": v.categoryName || parent?.categoryName || "",
      "Product": v.productName || "",
      "Storage": v.storage || "",
      "Colour": colourOf(v),
      "Price (USD)": Number.isFinite(v.price) ? v.price : "",
      "Discount price": Number.isFinite(v.discountPrice) ? v.discountPrice : "",
      "Original price": Number.isFinite(v.originalPrice) ? v.originalPrice : "",
      "Condition grade": v.cosmeticGrade || "",
      "Battery %": Number.isFinite(v.batteryHealth) ? v.batteryHealth : "",
      "Carrier": v.carrierStatus || "",
      "Device type": v.deviceType || "",
      "IMEI": v.imei || "",
      "Serial number": v.serialNumber || "",
      "Sellable state": v.refurbState || "",
      "In stock": v.outOfStock ? "No" : "Yes",
      "Accessory": v.isAccessory ? "Yes" : "No",
      "Has photo": blank(v.image) ? "NO" : (v.imageIsGeneric ? "Stand-in only" : "Yes"),
      "Description": v.description || "",
      "Needs from client": needs.join("; "),
      "Price note": outlier,
    });
  });

  // --- report -------------------------------------------------------------
  const pct = (n) => (variants.length ? `${Math.round((n / variants.length) * 100)}%` : "—");

  console.log(`\n  UpCell catalogue audit — ${new Date().toDateString()}`);
  console.log(`  ${process.env.MONGODB_URL.split("/").pop().split("?")[0]}\n`);
  console.log(`  ${variants.length} rows: ${devices.length} devices, ${accessories.length} accessories`);
  console.log(`  ${parents.length} product families\n`);

  const line = (label, list, note = "") =>
    console.log(`  ${String(list.length).padStart(5)}  ${pct(list.length).padStart(4)}  ${label}${note ? `  — ${note}` : ""}`);

  console.log("  MISSING PHOTOS");
  line("no photo at all", issues.noImage);
  line("stand-in photo only", issues.genericImage, "the family photo, not this unit");

  console.log("\n  MISSING DETAILS");
  line("no price", issues.noPrice);
  line("no storage", issues.noStorage);
  line("no colour", issues.noColour);
  line("no condition grade", issues.noGrade);
  line("no battery reading", issues.noBattery);
  line("no carrier status", issues.noCarrier);
  line("no device type", issues.noDeviceType);
  line("no IMEI or serial", issues.noIdentity, "blocks IDENTITY_REQUIRED");
  line("no description", issues.noDescription);

  console.log("\n  WORTH A LOOK");
  line("discount above price", issues.badDiscount);
  line("price far from its model group", issues.priceOutlier,
    `checked against ${outlierCoverage} units in groups of ${MIN_GROUP_FOR_OUTLIER}+`);
  line("no slug (unreachable URL)", issues.noSlug);
  line("orphaned (no product family)", issues.orphaned);

  if (gradeNotPriced.length) {
    console.log(`
  CONDITION IS NOT IN THE PRICE`);
    console.log(`  ${gradeNotPriced.length} model+storage groups hold more than one condition grade`);
    console.log(`  and price every unit the same. A Good phone and an Excellent one at`);
    console.log(`  the same money means one of the two is wrong.
`);
    gradeNotPriced.slice(0, 12).forEach((g) =>
      console.log(`    ${g.group}  ${g.grades}  all $${g.price}  (${g.units} units)`));
    if (gradeNotPriced.length > 12) console.log(`    …and ${gradeNotPriced.length - 12} more`);
  }

  if (issues.badDiscount.length) {
    console.log("\n  Discounts above the price they discount:");
    issues.badDiscount.slice(0, 20).forEach((r) => console.log(`    ${r.name} ${r.storage} — ${r.detail}`));
  }

  if (issues.priceOutlier.length) {
    console.log("\n  Prices worth checking (not necessarily wrong):");
    issues.priceOutlier.slice(0, 30).forEach((r) => console.log(`    ${r.name} ${r.storage} — ${r.detail}`));
  }

  if (issues.noPrice.length) {
    console.log("\n  No price at all:");
    issues.noPrice.slice(0, 30).forEach((r) => console.log(`    ${r.name} ${r.storage || ""} (${r.id})`));
  }

  const needsWork = rows.filter((r) => r["Needs from client"]).length;
  console.log(`\n  ${needsWork} of ${rows.length} rows need something from the client.\n`);

  // --- CSV ----------------------------------------------------------------
  if (WRITE_CSV) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const columns = Object.keys(rows[0]);
    const stamp = new Date().toISOString().slice(0, 10);

    const all = path.join(OUT_DIR, `upcell-catalogue-${stamp}.csv`);
    fs.writeFileSync(all, toCsv(rows, columns), "utf8");

    const gaps = rows.filter((r) => r["Needs from client"]);
    const todo = path.join(OUT_DIR, `upcell-needs-filling-in-${stamp}.csv`);
    fs.writeFileSync(todo, toCsv(gaps, columns), "utf8");

    console.log(`  Written:\n    ${all}\n    ${todo}\n`);
  } else {
    console.log("  Re-run with --csv to write the spreadsheets.\n");
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
