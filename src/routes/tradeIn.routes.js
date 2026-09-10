const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { tradeInRequestSchema, tradeInQuoteSchema } = require("../schemas/request.schemas");
const {
  getTradeInCatalog,
  getTradeInQuote,
} = require("../controllers/tradeInCatalog.controller");
const {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  deleteTradeInRequest,
} = require("../controllers/tradeIn.controller");

// What UpCell quotes for, and what each device type is asked. Public and
// cached: the same answer for everyone, and it changes when staff edit a
// price rather than when a customer does anything.
router.get("/trade-in-catalog", getTradeInCatalog);

// What this exact device is worth. Rate limited like the other public writes
// even though it writes nothing — it is the one endpoint somebody would hammer
// to map the whole price book by trying every combination.
router.post(
  "/trade-in-quote",
  publicFormLimiter,
  validateRequest(tradeInQuoteSchema),
  getTradeInQuote
);

router.post(
  "/trade-in-requests",
  publicFormLimiter,
  validateRequest(tradeInRequestSchema),
  createTradeInRequest
);
router.get("/admin-trade-in-requests/:status", verifyToken, requireAdmin, getAdminTradeInRequests);
router.patch(
  "/trade-in-requests/:id/status",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  updateTradeInStatus
);
router.delete("/trade-in-requests/:id", verifyToken, requireAdmin, validateObjectIdParam(), deleteTradeInRequest);

module.exports = router;
