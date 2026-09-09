require("dotenv").config();
const mongoose = require("mongoose");
const { parentSlug, variantSlug, ensureUniqueSlug } = require("../src/utils/slug");

// Gives every existing product and family the slug its URL is built from.
//
//   node scripts/backfill-slugs.js            dry run — prints, changes nothing
//   node scripts/backfill-slugs.js --write    actually writes
//
// Safe to run more than once: records that already have a slug are skipped, so
// a half-finished run can simply be repeated. Slugs are never regenerated for a
// record that has one, because a slug that changes is a URL that breaks.

const WRITE = process.argv.includes("--write");

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection;
  const parents = db.collection("parentproducts");
  const variations = db.collection("singlevariations");

  // Slugs already in use, so a re-run does not hand out one that is taken.
  const takenParent = new Set(
    (await parents.find({ slug: { $exists: true } }, { projection: { slug: 1 } }).toArray())
      .map((doc) => doc.slug)
      .filter(Boolean)
  );
  const takenVariant = new Set(
    (await variations.find({ slug: { $exists: true } }, { projection: { slug: 1 } }).toArray())
      .map((doc) => doc.slug)
      .filter(Boolean)
  );

  const report = { parents: { done: 0, skipped: 0, suffixed: [] }, variations: { done: 0, skipped: 0, suffixed: [] } };

  const parentDocs = await parents.find({}, { projection: { modelName: 1, slug: 1 } }).toArray();
  for (const doc of parentDocs) {
    if (doc.slug) { report.parents.skipped += 1; continue; }

    const base = parentSlug(doc.modelName);
    const slug = await ensureUniqueSlug(base, async (candidate) => takenParent.has(candidate));
    if (slug !== base) report.parents.suffixed.push(`${doc.modelName} -> ${slug}`);

    takenParent.add(slug);
    if (WRITE) await parents.updateOne({ _id: doc._id }, { $set: { slug } });
    report.parents.done += 1;
  }

  const variantDocs = await variations
    .find({}, { projection: { productName: 1, storage: 1, color: 1, slug: 1 } })
    .toArray();
  for (const doc of variantDocs) {
    if (doc.slug) { report.variations.skipped += 1; continue; }

    const base = variantSlug(doc);
    const slug = await ensureUniqueSlug(base, async (candidate) => takenVariant.has(candidate));
    if (slug !== base) report.variations.suffixed.push(`${doc.productName} ${doc.storage} -> ${slug}`);

    takenVariant.add(slug);
    if (WRITE) await variations.updateOne({ _id: doc._id }, { $set: { slug } });
    report.variations.done += 1;
  }

  console.log(WRITE ? "WROTE changes" : "DRY RUN — nothing written, pass --write to apply");
  console.log("");
  console.log(`parents    : ${report.parents.done} slugged, ${report.parents.skipped} already had one`);
  console.log(`variations : ${report.variations.done} slugged, ${report.variations.skipped} already had one`);

  // A suffix means two records produced the same slug. Worth seeing rather than
  // silently accepting: it usually means duplicated product data.
  const suffixed = [...report.parents.suffixed, ...report.variations.suffixed];
  if (suffixed.length) {
    console.log("");
    console.log(`needed a numeric suffix (${suffixed.length}) — check these are genuinely different products:`);
    suffixed.slice(0, 20).forEach((line) => console.log("  ", line));
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("FAILED:", error.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
