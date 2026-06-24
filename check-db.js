const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";

async function checkConnection() {
  console.log(`Checking MongoDB connection at: ${uri}`);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 2000,
    });
    console.log("SUCCESS: Successfully connected to MongoDB.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("FAILURE: Could not connect to MongoDB.");
    console.error(`Error details: ${err.message}`);
    process.exit(1);
  }
}

checkConnection();
