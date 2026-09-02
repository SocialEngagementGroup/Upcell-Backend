const { runReconciliation } = require("./reconciliation");

// Deliberately setInterval and not a cron package. Render's free plan sleeps
// the service when idle, so no in-process timer can be relied on to fire — a
// scheduling library would add a dependency and still miss runs. This gives a
// best-effort run whenever the server happens to be awake, and the admin
// "Run check now" endpoint covers the rest until the plan is upgraded.
//
// Keep the last result in memory so the admin page can show when the check
// last ran without re-running it.
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

let lastReport = null;
let timer = null;

const getLastReport = () => lastReport;

async function runNow(options) {
  lastReport = await runReconciliation(options);

  const { critical = [], warnings = [] } = lastReport;
  if (critical.length || warnings.length) {
    console.warn(
      `[reconciliation] ${critical.length} critical, ${warnings.length} warnings`
    );
  } else {
    console.log("[reconciliation] clean");
  }

  return lastReport;
}

function startScheduler() {
  if (timer) return;

  // Not immediately on boot: the database connection is still opening, and a
  // restart loop would otherwise fire an alert on every restart.
  setTimeout(() => {
    runNow().catch((error) => console.error("[reconciliation] first run failed:", error));

    timer = setInterval(() => {
      runNow().catch((error) => console.error("[reconciliation] scheduled run failed:", error));
    }, EVERY_MS);

    // Do not hold the process open just for this timer.
    if (timer.unref) timer.unref();
  }, FIRST_RUN_DELAY_MS).unref?.();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startScheduler, stopScheduler, runNow, getLastReport };
