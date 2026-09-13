#!/usr/bin/env node
/**
 * Is the deployed backend current, and is the database behind it migrated?
 *
 *   node scripts/check-deployment.js https://upcell-backend-1uns.onrender.com
 *
 * Read-only, unauthenticated, and safe to run against production. It only
 * calls public endpoints.
 *
 * Two separate questions, and they fail in ways that look identical from a
 * browser — a broken image can mean old code or unmigrated data, and telling
 * them apart by hand takes an afternoon:
 *
 *   1. **Is the code current?** Probed by asking for endpoints that only exist
 *      after a given task. A 404 on /health means the deploy predates T17-B,
 *      whatever the commit history says was merged.
 *
 *   2. **Is the data migrated?** Probed by reading the public catalogue and
 *      looking for the fields the migrations add. This question can only be
 *      answered once the code is current — an old Mongoose schema strips
 *      fields it does not declare from a hydrated read, so new data behind old
 *      code looks exactly like no data at all. The script says so rather than
 *      guessing.
 */

const BASE = (process.argv[2] || "").replace(/\/+$/, "");

if (!BASE) {
  console.error("Usage: node scripts/check-deployment.js <backend url>");
  process.exit(1);
}

// Each endpoint and the task that introduced it. A 404 dates the deploy.
const CODE_MARKERS = [
  { path: "/health", since: "T17-B", what: "health check" },
  { path: "/tax-rate", since: "T01-B", what: "server-side sales tax" },
  { path: "/trade-in-catalog", since: "T03-B", what: "server-side trade-in pricing" },
];

// Fields a migration adds, and the script that adds it.
const DATA_MARKERS = [
  { field: "slug", script: "backfill-slugs.js", breaks: "product pages bounce back to /shop" },
  { field: "imagePublicId", script: "backfill-image-public-ids.js", breaks: "every product image is broken" },
  { field: "cosmeticGrade", script: "migrate-condition-to-grade.js", breaks: "no condition badge on a card" },
  { field: "refurbState", script: "backfill-device-identity.js", breaks: "nothing — the shop query tolerates it missing" },
];

const get = async (path) => {
  try {
    const res = await fetch(BASE + path, { redirect: "manual" });
    const text = await res.text();
    // A Render 404 and a Vercel rewrite both answer with HTML. Neither is JSON,
    // and treating "it responded" as "it works" is how this gets missed.
    return { status: res.status, html: text.trimStart().startsWith("<"), text };
  } catch (error) {
    return { error: error.message };
  }
};

async function main() {
  console.log(`\n  ${BASE}\n`);

  // --- 1. the code -------------------------------------------------------
  console.log("  CODE");
  let stale = 0;
  for (const marker of CODE_MARKERS) {
    const res = await get(marker.path);
    const ok = res.status === 200 && !res.html;
    if (!ok) stale += 1;
    console.log(`    ${ok ? "ok     " : "MISSING"}  ${marker.path.padEnd(20)} ${marker.what} (${marker.since})`);
  }

  if (stale) {
    console.log(`\n    ${stale} of ${CODE_MARKERS.length} endpoints are missing.`);
    console.log("    The deployed build predates them. Redeploy before reading anything below —");
    console.log("    an old schema hides new fields, so the data check cannot be trusted yet.\n");
  } else {
    console.log("    The deploy is current.\n");
  }

  // --- 2. the data -------------------------------------------------------
  console.log("  DATA");
  const shop = await get("/products/shop");

  if (shop.error || shop.status !== 200 || shop.html) {
    console.log(`    Could not read the catalogue (${shop.error || shop.status}).\n`);
    process.exit(stale ? 1 : 0);
  }

  let products = [];
  try {
    const body = JSON.parse(shop.text);
    products = Array.isArray(body) ? body : body.items || body.products || [];
  } catch {
    console.log("    The catalogue did not answer with JSON.\n");
    process.exit(1);
  }

  console.log(`    ${products.length} products in the public catalogue`);

  const missing = [];
  for (const marker of DATA_MARKERS) {
    const have = products.filter((p) => p[marker.field] !== undefined && p[marker.field] !== null && p[marker.field] !== "").length;
    const short = products.length - have;
    if (short) missing.push({ ...marker, short });
    console.log(`    ${short ? "MISSING" : "ok     "}  ${marker.field.padEnd(16)} ${have}/${products.length} have it`);
  }

  // --- what to do --------------------------------------------------------
  if (stale) {
    console.log("\n  NEXT: redeploy the backend, then run this again.");
    console.log("  Until then the DATA section above is not evidence of anything.\n");
    process.exit(1);
  }

  if (missing.length) {
    console.log("\n  NEXT: run these against this deployment's database, dry run first.\n");
    missing.forEach((m) => {
      console.log(`    node scripts/${m.script}`);
      console.log(`      ${m.short} products lack ${m.field} — ${m.breaks}\n`);
    });
    process.exit(1);
  }

  console.log("\n  Code is current and the data is migrated.\n");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
