const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { runNow, getLastReport } = require("../services/scheduler");
const {
  getPaymentEvents,
  getPaymentSummary,
} = require("../controllers/paymentLog.controller");

router.get("/admin-payment-events", verifyToken, requireAdmin, getPaymentEvents);
router.get("/admin-payment-summary", verifyToken, requireAdmin, getPaymentSummary);

// Admin-only. The check reads every payment record and can raise alerts, so it
// is not something an anonymous caller should be able to trigger.
router.get("/admin-payment-check", verifyToken, requireAdmin, (req, res) => {
  res.json(getLastReport() || { ok: true, neverRun: true });
});

router.post("/admin-payment-check", verifyToken, requireAdmin, async (req, res, next) => {
  try {
    res.json(await runNow());
  } catch (error) {
    next(error);
  }
});

module.exports = router;
