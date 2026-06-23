const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGODB_URL;
const env = process.env.NODE_ENV || "development";
const dbName = env === "production" ? "upcell_prod" : "upcell_dev";

function connectToDb() {
  let state = mongoose.connection.readyState;

  if (!state || state === 3) {
    const maskedUri = uri ? uri.replace(/:([^:@]+)@/, ":****@") : "NOT SET";
    console.log(`🌍 Environment : ${env.toUpperCase()}`);
    console.log(`🗄️  Database    : ${dbName}`);
    console.log(`📡 Connecting  : ${maskedUri}`);

    mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        heartbeatFrequencyMS: 10000, // ping Atlas every 10s to keep connection alive
        minPoolSize: 5,              // keep 5 connections warm in the pool
        maxPoolSize: 10,
      })
      .then(() => {
        console.log(
          `✅ MongoDB connected → [${dbName}] (${env} environment)`
        );
      })
      .catch((err) => {
        console.error(`❌ MongoDB connection failed (${env} environment).`);
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
    console.log(`🔌 MongoDB disconnected from [${dbName}]`);
  }
}

const db = mongoose.connection;
db.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err.message);
});

module.exports = { connectToDb, disconnectDb };
