// Says which database a script is about to touch, before it touches it.
//
// Every script here reads MONGODB_URL from whatever .env happens to be on the
// machine. That is convenient and it is also how somebody runs a production
// migration against development and reads a clean report as success — which
// has now happened: `backfill-slugs.js` reported "956 already had one" against
// a production database holding 954 products with none.
//
// scripts/README.md has always said "check which database it printed". Most of
// them did not print one. This makes that true for all of them.
//
// Required for its side effect, immediately after dotenv:
//
//     require("dotenv").config();
//     require("./lib/announce-db");
//
// It wraps mongoose.connect rather than asking each script to call something,
// so a script that forgets a line still cannot connect silently.

const mongoose = require("mongoose");

// Databases where a mistake is expensive. Matched loosely on purpose: a name
// like upcell_prod_backup should shout too.
const LOOKS_LIVE = /prod/i;

const nameFrom = (uri) => {
  try {
    // The path of a mongodb:// or mongodb+srv:// URI is the database.
    const withoutScheme = String(uri).replace(/^mongodb(\+srv)?:\/\//, "");
    const path = withoutScheme.split("/")[1] || "";
    return path.split("?")[0] || "(default)";
  } catch {
    return "(unreadable)";
  }
};

const original = mongoose.connect.bind(mongoose);

mongoose.connect = function announceThenConnect(uri, ...rest) {
  const name = nameFrom(uri);
  const writing = process.argv.some((a) => ["--write", "--apply", "--yes"].includes(a));

  const line = "─".repeat(58);
  console.log(`\n${line}`);
  console.log(`  Database : ${name}`);
  console.log(`  Mode     : ${writing ? "WRITING — changes will be saved" : "dry run"}`);

  // The combination worth stopping for. A dry run against production is fine
  // and often the point; a write is the one to be sure about.
  if (LOOKS_LIVE.test(name) && writing) {
    console.log(`  ${"!".repeat(52)}`);
    console.log(`  This will WRITE to what looks like a LIVE database.`);
    console.log(`  ${"!".repeat(52)}`);
  }
  console.log(`${line}\n`);

  return original(uri, ...rest);
};

module.exports = { nameFrom };
