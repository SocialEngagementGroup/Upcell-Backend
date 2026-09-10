const { runReconciliation } = require("./reconciliation");
const { runReturnJobs } = require("./returnMaintenance");

// Deliberately setInterval and not a cron package. The service is on Render's
// Starter plan now and stays awake, so an in-process timer does fire — which
// makes a scheduling library a dependency that buys nothing this file does not
// already do in fifteen lines.
//
// The admin "Run check now" endpoint stays. A restart resets the interval, and
// a deploy at the wrong moment can still skip a window, so a person needs a
// way to ask for the check rather than wait six hours for the next one.
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

  // Returns maintenance rides along on the same timer rather than adding a
  // second one. It is deliberately not allowed to fail the reconciliation
  // report: a reminder email that did not send must not hide a payment
  // discrepancy, which is the more serious of the two by a wide margin.
  runReturnJobs().catch((error) =>
    console.error("[returns] maintenance failed:", error?.message || error)
  );

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
