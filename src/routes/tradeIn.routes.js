const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const {
  tradeInRequestSchema,
  tradeInQuoteSchema,
  priceBookEntrySchema,
  questionSetSchema,
  tradeInPayoutSchema,
} = require("../schemas/request.schemas");
const {
  getTradeInCatalog,
  getTradeInQuote,
  getAdminPriceBook,
  updatePriceBookEntry,
  updateQuestionSet,
} = require("../controllers/tradeInCatalog.controller");
const {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  recordTradeInPayout,
  getTradeInReport,
  deleteTradeInRequest,
} = require("../controllers/tradeIn.controller");

// What UpCell quotes for, and what each device type is asked. Public and
// cached: the same answer for everyone, and it changes when staff edit a
// price rather than when a customer does anything.
router.get("/trade-in-catalog", getTradeInCatalog);

// The price book, for the people who set the prices. Until this existed the
// numbers were seeded and then unreachable — a developer for every change.
router.get("/admin-trade-in-pricebook", verifyToken, requireAdmin, getAdminPriceBook);

// One model at a time. A bulk write lets a stale tab overwrite somebody
// else's edit with no way to tell afterwards.
router.patch(
  "/admin-trade-in-pricebook/:modelKey",
  verifyToken,
  requireAdmin,
  validateRequest(priceBookEntrySchema),
  updatePriceBookEntry
);

// A whole set at a time, unlike the prices: the questions are an ordered list
// whose order and multipliers only make sense together.
router.put(
  "/admin-trade-in-questions/:deviceType",
  verifyToken,
  requireAdmin,
  validateRequest(questionSetSchema),
  updateQuestionSet
);

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
// The report, and the same report as a file. One handler: two endpoints
// computing the same numbers separately is two places for them to drift.
router.get("/admin-trade-in-report", verifyToken, requireAdmin, getTradeInReport);
router.get("/admin-trade-in-report.csv", verifyToken, requireAdmin, getTradeInReport);

// Recording the payment and marking it paid are one action. Two endpoints
// would let a request sit at Paid with no record of how, which is the state
// somebody has to reconstruct from a bank statement months later.
router.patch(
  "/admin-trade-in-requests/:id/payout",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(tradeInPayoutSchema),
  recordTradeInPayout
);
router.delete("/trade-in-requests/:id", verifyToken, requireAdmin, validateObjectIdParam(), deleteTradeInRequest);

module.exports = router;
