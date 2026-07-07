const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { tradeInRequestSchema } = require("../schemas/request.schemas");
const {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  deleteTradeInRequest,
} = require("../controllers/tradeIn.controller");

router.post(
  "/trade-in-requests",
  publicFormLimiter,
  validateRequest(tradeInRequestSchema),
  createTradeInRequest
);
router.get("/admin-trade-in-requests/:status", verifyToken, requireAdmin, getAdminTradeInRequests);
router.patch("/trade-in-requests/:id/status", verifyToken, requireAdmin, updateTradeInStatus);
router.delete("/trade-in-requests/:id", verifyToken, requireAdmin, deleteTradeInRequest);

module.exports = router;
