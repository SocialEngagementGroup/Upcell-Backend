require("dotenv").config();

const { validateEnv } = require("./config/env");

validateEnv();

const app = require("./app");
const { connectToDb } = require("./config/database");
const { startScheduler } = require("./services/scheduler");

const port = process.env.PORT || 5000;

connectToDb();

app.listen(port, () => {
  console.log("server is running on port, ", port);

  // Best-effort payment check. It cannot be the only safeguard while the host
  // is allowed to sleep, which is why the admin dashboard can also run it on
  // demand — see routes/reconciliation.routes.js.
  startScheduler();
});
