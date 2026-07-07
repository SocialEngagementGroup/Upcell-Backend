require("dotenv").config();

const { validateEnv } = require("./config/env");

validateEnv();

const app = require("./app");
const { connectToDb } = require("./config/database");

const port = process.env.PORT || 5000;

connectToDb();

app.listen(port, () => {
  console.log("server is running on port, ", port);
});
