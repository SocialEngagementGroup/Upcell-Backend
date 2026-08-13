require("dotenv").config();
const mongoose = require("mongoose");

// Copies image fields from the development database to production.
//
// Why this exists: the Cloudinary backfill was only ever run against
// upcell_development. It added a `publicId` alongside the original `url` on
// every image reference rather than replacing it, and the frontend's
// resolveImageRef() prefers publicId and falls back to url. Production never
// got the backfill, so its documents still carry url only — and because the
// real PNGs were deleted from Frontend/public/staticImages when the catalogue
// moved to Cloudinary, those urls now 404. That is the broken-image symptom:
// dev resolves through Cloudinary, prod falls back to files that no longer ship.
//
// Scope is deliberately narrow. Only these fields are written:
//
//   parentproducts.images     (array of { url, publicId, ... })
//   singlevariations.image, .imagePublicId, .imageWidth, .imageHeight
//   shopcategories.images     (array of { url, publicId, ... })
//
// The three extra variation fields matter as much as `image` does. Variations
// store the image as a bare string, so there is no object to carry a publicId
// the way parentproducts.images does — the backfill put it in a sibling
// `imagePublicId` field instead. resolveProductImage() falls back to that field
// whenever the manifest cannot match a product, which is the common path for
// models whose Cloudinary files are not colour-named (iPhone 17 Pro is stored
// as iphone-17-pro-1/2/3, so colour matching finds no candidate). Syncing
// `image` alone leaves those cards pointing at a deleted local PNG.
//
// Orders, trade-in requests, users, analytics, notifications and payment logs
// are never read or written. Production holds real customer records that do not
// exist in dev (10 orders vs 5, 8 trade-ins vs 7), so a wholesale database copy
// would destroy them. This syncs images and nothing else.
//
// Matching: by _id first. 27 variations were created independently in each
// database and share no _id, so those fall back to
// productName + storage + colour. Categories present in dev but not in prod are
// reported and skipped, never created — that keeps the test category out of prod.
//
// Dry run by default; pass --apply to write. Safe to re-run: documents already
// holding the target value are skipped.
//
//   node scripts/sync-images-dev-to-prod.js            # preview
//   node scripts/sync-images-dev-to-prod.js --apply    # write

const colourOf = (doc) => {
  const c = doc.color;
  if (!c) return "";
  if (typeof c === "string") return c;
  return String(c.name || c.colorName || c.colour || "").trim();
};

const variationKey = (doc) =>
  [doc.productName, doc.storage, colourOf(doc)].map((p) => String(p || "").trim().toLowerCase()).join("|");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const apply = process.argv.includes("--apply");

  const devUri = process.env.DEV_URL;
  const prodUri = process.env.PROD_URL;
  if (!devUri || !prodUri) {
    console.error("Set DEV_URL and PROD_URL to the two connection strings.");
    process.exitCode = 1;
    return;
  }

  const dev = await mongoose.createConnection(devUri, { serverSelectionTimeoutMS: 15000 }).asPromise();
  const prod = await mongoose.createConnection(prodUri, { serverSelectionTimeoutMS: 15000 }).asPromise();

  if (!/development/i.test(dev.name) || !/production/i.test(prod.name)) {
    console.error(`Refusing to run: expected dev/prod databases, got "${dev.name}" -> "${prod.name}".`);
    await dev.close();
    await prod.close();
    process.exitCode = 1;
    return;
  }

  console.log(`source   : ${dev.name}`);
  console.log(`target   : ${prod.name}`);
  console.log(`mode     : ${apply ? "APPLY (writing to production)" : "dry run (no writes)"}\n`);

  const summary = [];

  // --- parentproducts.images -------------------------------------------------
  {
    const devDocs = await dev.db.collection("parentproducts").find({}).toArray();
    const prodCol = prod.db.collection("parentproducts");
    let changed = 0;
    let current = 0;
    const missing = [];

    for (const d of devDocs) {
      const p = await prodCol.findOne({ _id: d._id }, { projection: { images: 1 } });
      if (!p) {
        missing.push(d.modelName);
        continue;
      }
      if (same(p.images, d.images)) {
        current += 1;
        continue;
      }
      changed += 1;
      if (apply) await prodCol.updateOne({ _id: d._id }, { $set: { images: d.images || [] } });
    }
    summary.push({ what: "parentproducts.images", changed, current, missing });
  }

  // --- singlevariations.image ------------------------------------------------
  {
    const IMAGE_FIELDS = ["image", "imagePublicId", "imageWidth", "imageHeight"];
    const devDocs = await dev.db.collection("singlevariations").find({}).toArray();
    const prodCol = prod.db.collection("singlevariations");
    const prodDocs = await prodCol
      .find({}, { projection: { productName: 1, storage: 1, color: 1, image: 1, imagePublicId: 1, imageWidth: 1, imageHeight: 1 } })
      .toArray();

    const byId = new Map(prodDocs.map((d) => [String(d._id), d]));
    const byKey = new Map();
    for (const d of prodDocs) {
      const k = variationKey(d);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(d);
    }

    let changed = 0;
    let current = 0;
    let viaKey = 0;
    const missing = [];
    const usedIds = new Set();

    for (const d of devDocs) {
      let target = byId.get(String(d._id));
      if (!target) {
        const pool = (byKey.get(variationKey(d)) || []).filter((c) => !usedIds.has(String(c._id)));
        target = pool[0];
        if (target) viaKey += 1;
      }
      if (!target) {
        missing.push(`${d.productName} ${d.storage} ${colourOf(d)}`);
        continue;
      }
      usedIds.add(String(target._id));

      const patch = {};
      for (const f of IMAGE_FIELDS) {
        if (d[f] !== undefined && !same(target[f], d[f])) patch[f] = d[f];
      }
      if (!Object.keys(patch).length) {
        current += 1;
        continue;
      }
      changed += 1;
      if (apply) await prodCol.updateOne({ _id: target._id }, { $set: patch });
    }
    summary.push({ what: "singlevariations (image + imagePublicId/Width/Height)", changed, current, missing, note: `${viaKey} matched by name/storage/colour` });
  }

  // --- shopcategories.images -------------------------------------------------
  {
    const devDocs = await dev.db.collection("shopcategories").find({}).toArray();
    const prodCol = prod.db.collection("shopcategories");
    let changed = 0;
    let current = 0;
    const missing = [];

    for (const d of devDocs) {
      let p = await prodCol.findOne({ _id: d._id }, { projection: { images: 1 } });
      if (!p && d.modelName) p = await prodCol.findOne({ modelName: d.modelName }, { projection: { images: 1 } });
      if (!p) {
        missing.push(d.modelName || String(d._id));
        continue;
      }
      if (same(p.images, d.images)) {
        current += 1;
        continue;
      }
      changed += 1;
      if (apply) await prodCol.updateOne({ _id: p._id }, { $set: { images: d.images || [] } });
    }
    summary.push({ what: "shopcategories.images", changed, current, missing, note: "categories absent from prod are skipped, not created" });
  }

  console.log("--------------------------------------------");
  for (const s of summary) {
    console.log(`${s.what}`);
    console.log(`   ${apply ? "updated" : "to update"} : ${s.changed}`);
    console.log(`   already current : ${s.current}`);
    if (s.note) console.log(`   note            : ${s.note}`);
    if (s.missing.length) {
      console.log(`   not in prod (${s.missing.length}), skipped:`);
      s.missing.slice(0, 10).forEach((m) => console.log(`      - ${m}`));
    }
  }

  if (!apply) console.log("\nDry run only. Re-run with --apply to write these changes.");

  await dev.close();
  await prod.close();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
