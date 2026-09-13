#!/usr/bin/env node
/**
 * Moves the catalogue onto the returns grading scale.
 *
 *   node scripts/migrate-condition-to-grade.js            dry run
 *   node scripts/migrate-condition-to-grade.js --write    apply
 *
 * The catalogue grades devices Mint / Excellent / Good / New. Returns grade
 * them Excellent / Good / Fair / Fail. Two scales cannot both be right, and the
 * comparison that matters — did this device come back worse than it sold at —
 * needs one.
 *
 * The mapping is deliberately lossy in the safe direction. Mint and New both
 * become Excellent, because Excellent is the top of the returns scale and
 * nothing above it exists there; a device sold as Mint that comes back
 * Excellent therefore reads as unchanged rather than as a downgrade, which is
 * the correct answer. Nothing is ever mapped downward.
 *
 * The original value is kept in `conditionLegacy` rather than overwritten. If
 * "Mint" turns out to mean something UpCell wants to keep selling on, the
 * information is still there.
 *
 * Safe to re-run: a product already carrying a grade is skipped.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { GRADES } = require("../src/constants/grading");

const WRITE = process.argv.includes("--write");

// Everything the catalogue actually contains, checked against the data rather
// than guessed: Excellent 491, Mint 248, Good 215, New 2.
const MAPPING = {
  mint: GRADES.EXCELLENT,
  new: GRADES.EXCELLENT,
  excellent: GRADES.EXCELLENT,
  good: GRADES.GOOD,
  fair: GRADES.FAIR,
  refubrished: GRADES.GOOD,
};

const gradeFor = (condition) => MAPPING[String(condition || "").trim().toLowerCase()] || null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
  const variations = mongoose.connection.collection("singlevariations");

  const docs = await variations
    .find({}, { projection: { condition: 1, cosmeticGrade: 1 } })
    .toArray();

  const byGrade = {};
  const unmapped = {};
  const updates = [];

  for (const doc of docs) {
    if (doc.cosmeticGrade) continue;

    const grade = gradeFor(doc.condition);

    if (!grade) {
      // Left alone rather than guessed at. A product with a condition nobody
      // anticipated should surface as a number to look at, not be silently
      // filed as Good.
      const key = String(doc.condition);
      unmapped[key] = (unmapped[key] || 0) + 1;
      continue;
    }

    byGrade[grade] = (byGrade[grade] || 0) + 1;
    updates.push({ _id: doc._id, grade, condition: doc.condition });
  }

  console.log(WRITE ? "MODE: WRITE\n" : "MODE: DRY RUN (use --write to apply)\n");
  console.log(`products              : ${docs.length}`);
  console.log(`already graded        : ${docs.filter((doc) => doc.cosmeticGrade).length}`);
  console.log(`to grade              : ${updates.length}`);
  console.log("\nmapping:");
  for (const [grade, count] of Object.entries(byGrade)) {
    console.log(`  ${String(count).padStart(4)} -> ${grade}`);
  }

  if (Object.keys(unmapped).length) {
    console.log("\nUNMAPPED — left untouched, look at these:");
    for (const [condition, count] of Object.entries(unmapped)) {
      console.log(`  ${String(count).padStart(4)}  ${JSON.stringify(condition)}`);
    }
  }

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written.");
    await mongoose.disconnect();
    return;
  }

  // One bulk write rather than 956 round trips.
  await variations.bulkWrite(
    updates.map((update) => ({
      updateOne: {
        filter: { _id: update._id },
        update: {
          $set: {
            cosmeticGrade: update.grade,
            // Kept, not overwritten. "Mint" may still mean something to UpCell.
            conditionLegacy: update.condition,
          },
        },
      },
    }))
  );

  console.log(`\nWROTE changes — ${updates.length} products graded`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
