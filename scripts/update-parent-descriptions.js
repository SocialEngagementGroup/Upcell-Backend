require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const ParentProduct = require("../src/models/parentProduct.model");
const SingleVariation = require("../src/models/singleVariation.model");

// Applies the marketing-supplied parent descriptions from
// parent-descriptions.json.
//
// The description is denormalised: it is stored once on the ParentProduct and
// again on every SingleVariation under it, because the shop and product cards
// read variations directly and never join back to the parent. So a parent with
// 18 storage/colour combinations needs 19 documents touched, not one. Updating
// only the parent leaves the site showing the old text everywhere it actually
// matters — which is the state this script was written to fix.
//
// Dry run by default; pass --apply to write. Safe to re-run: documents already
// holding the target text are skipped, so a partial run can simply be repeated.
//
//   node scripts/update-parent-descriptions.js            # preview
//   node scripts/update-parent-descriptions.js --apply    # write

const DATA_FILE = path.join(__dirname, "parent-descriptions.json");

async function main() {
  const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";
  const apply = process.argv.includes("--apply");

  const rows = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  const objectId = /^[0-9a-f]{24}$/i;
  const malformed = rows.filter((r) => !objectId.test(r._id) || !r.description || !r.description.trim());
  if (malformed.length) {
    console.error(`Refusing to run: ${malformed.length} row(s) have a bad _id or empty description.`);
    malformed.slice(0, 10).forEach((r) => console.error(`  - ${r.modelName} (${r._id})`));
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  console.log(`database : ${dbName}`);
  console.log(`mode     : ${apply ? "APPLY (writing)" : "dry run (no writes)"}`);
  console.log(`rows     : ${rows.length}\n`);

  let parentsToChange = 0;
  let variantsToChange = 0;
  let alreadyCurrent = 0;
  const notFound = [];

  for (const row of rows) {
    const target = row.description.trim();
    const parent = await ParentProduct.findById(row._id).select("_id modelName description").lean();

    if (!parent) {
      notFound.push(`${row.modelName} (${row._id})`);
      continue;
    }

    const parentStale = String(parent.description || "").trim() !== target;
    const staleVariants = await SingleVariation.countDocuments({
      parentCatagory: row._id,
      description: { $ne: target },
    });

    if (!parentStale && staleVariants === 0) {
      alreadyCurrent += 1;
      continue;
    }

    if (parentStale) parentsToChange += 1;
    variantsToChange += staleVariants;

    console.log(`${row.modelName}`);
    console.log(`   parent   : ${parentStale ? "update" : "already current"}`);
    console.log(`   variants : ${staleVariants} to update`);

    if (apply) {
      if (parentStale) {
        await ParentProduct.updateOne({ _id: row._id }, { $set: { description: target } });
      }
      if (staleVariants > 0) {
        await SingleVariation.updateMany(
          { parentCatagory: row._id, description: { $ne: target } },
          { $set: { description: target } }
        );
      }
    }
  }

  console.log("\n--------------------------------------------");
  console.log(`already current      : ${alreadyCurrent} model(s)`);
  console.log(`parents  ${apply ? "updated" : "to update"} : ${parentsToChange}`);
  console.log(`variants ${apply ? "updated" : "to update"} : ${variantsToChange}`);

  if (notFound.length) {
    console.log(`\nNOT FOUND in ${dbName} (${notFound.length}) — these were skipped:`);
    notFound.forEach((n) => console.log(`  - ${n}`));
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
