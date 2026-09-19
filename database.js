const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGODB_URL;
const env = process.env.NODE_ENV || "development";

function getDbNameFromUri(connectionString) {
  if (!connectionString) return "unknown";

  try {
    const parsed = new URL(connectionString);
    return parsed.pathname.replace("/", "") || "default";
  } catch (error) {
    const match = connectionString.match(/\/([^/?]+)(?:\?|$)/);
    return match?.[1] || "unknown";
  }
}

const dbName = getDbNameFromUri(uri);

function connectToDb() {
  let state = mongoose.connection.readyState;

  if (!state || state === 3) {
    const maskedUri = uri ? uri.replace(/:([^:@]+)@/, ":****@") : "NOT SET";
    console.log(`Environment : ${env.toUpperCase()}`);
    console.log(`Database    : ${dbName}`);
    console.log(`Connecting  : ${maskedUri}`);

    mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        heartbeatFrequencyMS: 10000,
        minPoolSize: 5,
        maxPoolSize: 10,
        // Wire compression between this server and Atlas. The catalogue query
        // alone pulls about 750 KB of BSON on every uncached shop page.
        //
        // Deliberately an environment variable rather than a constant, and
        // deliberately unset by default, because this could not be measured
        // honestly from a developer machine. Benchmarked 19 Sep against
        // upcell_development: no compression 25.8s median, zlib 23.9s, and no
        // compression again 21.9s — the same configuration varying by four
        // seconds between runs, with zlib landing between its own control
        // rounds. That is a laptop's internet link to Atlas, not Render's; the
        // same endpoint answers in about half a second from Render.
        //
        // It also might not help. M0 and Flex are CPU-throttled, and
        // compressing 750 KB costs CPU at both ends — on a cluster that is
        // already burst-limited that can cost more than the bytes save.
        //
        // So: turn it on in Render's environment, watch the reconciliation
        // timings, and turn it off again if nothing improves. No deploy either
        // way. zlib needs nothing installed; zstd and snappy are optional npm
        // modules this project does not have, and the driver quietly falls back
        // to zlib when they are named but missing — verified, it does not throw.
        ...(process.env.MONGO_COMPRESSORS
          ? { compressors: process.env.MONGO_COMPRESSORS }
          : {}),
      })
      .then(() => {
        console.log(`MongoDB connected -> [${dbName}] (${env} environment)`);
      })
      .catch((err) => {
        console.error(`MongoDB connection failed (${env} environment).`);
        console.error(`   Database : ${dbName}`);
        console.error(`   Reason   : ${err.message}`);
        process.exit(1);
      });
  }
}

async function disconnectDb() {
  let state = mongoose.connection.readyState;
  if (state !== 0 && state !== 3) {
    await mongoose.disconnect();
    console.log(`MongoDB disconnected from [${dbName}]`);
  }
}

const db = mongoose.connection;
db.on("error", (err) => {
  console.error("MongoDB connection error:", err.message);
});

module.exports = { connectToDb, disconnectDb };
