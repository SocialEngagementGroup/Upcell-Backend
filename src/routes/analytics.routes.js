const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { analyticsLimiter } = require("../middleware/rateLimit.middleware");
const { analyticsEventSchema } = require("../schemas/request.schemas");
const {
  createAnalyticsEvent,
  getAdminAnalyticsSummary,
  getAdminAnalyticsEvents,
} = require("../controllers/analytics.controller");

router.post(
  "/analytics-events",
  analyticsLimiter,
  validateRequest(analyticsEventSchema),
  createAnalyticsEvent
);
router.get("/admin-analytics-summary", verifyToken, requireAdmin, getAdminAnalyticsSummary);
router.get("/admin-analytics-events", verifyToken, requireAdmin, getAdminAnalyticsEvents);

module.exports = router;
