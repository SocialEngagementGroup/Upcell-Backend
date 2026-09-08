const router = require("express").Router();
const { verifyToken, requireAdmin, optionalAuth } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { checkoutLimiter } = require("../middleware/rateLimit.middleware");
const { orderSchema, refundSchema } = require("../schemas/request.schemas");
const {
  getOrder,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  processRefund,
  markRefundEnteredAtBank,
  getClientOrders,
  createOrder,
} = require("../controllers/order.controller");

router.get("/order/:id", optionalAuth, getOrder);
router.get("/admin-orders/:status", verifyToken, requireAdmin, getAdminOrders);
router.get("/admin-orders-by-data", verifyToken, requireAdmin, getAdminOrdersByDate);
router.post("/update-order-status", verifyToken, requireAdmin, updateOrderStatus);
router.post("/admin-orders/:id/refund", verifyToken, requireAdmin, validateRequest(refundSchema), processRefund);
// Takes no body — the caller is only saying "I have now entered this at the
// bank", and the amount is whatever the refund already recorded. A body would
// invite the figure being retyped, and a second chance to get it wrong.
router.patch(
  "/admin-orders/:id/refund/entered",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  markRefundEnteredAtBank
);
router.get("/client-orders/:email", verifyToken, getClientOrders);
// Same reasoning as /boa/prepare-payment: this created a real order for an
// anonymous caller. No frontend code calls it, which made it an unauthenticated
// write nobody was watching.
router.post("/orders", checkoutLimiter, verifyToken, validateRequest(orderSchema), createOrder);

module.exports = router;
