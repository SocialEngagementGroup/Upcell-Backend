const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";

function connectToDb() {
  let state = mongoose.connection.readyState;

  if (!state || state == 3) {
    console.log(`📡 Attempting to connect to local database at: ${uri}`);
    mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      // Increase timeout for local dev
      serverSelectionTimeoutMS: 5000, 
    }).then(() => {
      console.log("✅ Database connected successfully to local MongoDB");
    }).catch(err => {
      console.error("❌ Database connection failed.");
      console.error(`Please ensure MongoDB is running locally on your machine.`);
      console.error(`Error details: ${err.message}`);
    });
  }
}

async function disconnectDb() {
  let state = mongoose.connection.readyState;

  if (state !== 0 && state !== 3) {
    await mongoose.disconnect();
  }
}

const db = mongoose.connection;
db.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err.message);
});

module.exports = { connectToDb, disconnectDb };
