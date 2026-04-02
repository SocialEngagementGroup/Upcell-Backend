const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGODB_URL || "mongodb://localhost:27017/upcell";

async function checkConnection() {
  console.log(`🔍 Checking MongoDB connection at: ${uri}`);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 2000,
    });
    console.log("✅ SUCCESS: Successfully connected to your local MongoDB instance!");
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ FAILURE: Could not connect to MongoDB.");
    console.error(`Error details: ${err.message}`);
    console.warn("\n💡 Tips for fixing this:");
    console.warn("1. Make sure MongoDB is installed: https://www.mongodb.com/docs/manual/installation/");
    console.warn("2. Ensure the service is running (e.g., 'brew services start mongodb-community' or 'sudo systemctl start mongod')");
    console.warn("3. Check that your .env MONGODB_URL is correct.\n");
    process.exit(1);
  }
}

checkConnection();
