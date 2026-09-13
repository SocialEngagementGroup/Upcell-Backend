const router = require("express").Router();
const { verifyToken, requireAdmin, optionalAuth } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const {
  publicFormLimiter,
  checkoutLimiter,
  guestCheckoutLimiter,
  orderLookupLimiter,
} = require("../middleware/rateLimit.middleware");
const {
  orderSchema,
  refundSchema,
  orderShipmentSchema,
  orderLinkRequestSchema,
} = require("../schemas/request.schemas");
const {
  getOrder,
  getTaxRate,
  claimGuestOrders,
  deleteOwnAccount,
  emailOrderLink,
  recordOrderShipment,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  processRefund,
  markRefundEnteredAtBank,
  getClientOrders,
  createOrder,
} = require("../controllers/order.controller");

// The shop's tax rate. No auth: it is on every price the site quotes.
router.get("/tax-rate", getTaxRate);

// Called once after sign-in. Attaches any guest orders placed with the same
// verified email to the new account.
router.post("/orders/claim", verifyToken, claimGuestOrders);

// Deleting an account. Financial records are anonymised rather than removed —
// see services/accountDeletion.js and docs/data-retention.md.
router.delete("/account/me", verifyToken, deleteOwnAccount);

// A guest who lost their receipt asking for a fresh link. Public, because
// having lost the link is the whole reason they are here — and rate limited
// like the other public writes, because it sends email.
router.post(
  "/track-order",
  publicFormLimiter,
  validateRequest(orderLinkRequestSchema),
  emailOrderLink
);

// Marking an order shipped. Staff buy the label by hand in the carrier's own
// tool and paste the number back here — the same manual first phase the
// returns side runs on.
router.patch(
  "/admin-orders/:id/shipment",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(orderShipmentSchema),
  recordOrderShipment
);

router.get("/order/:id", orderLookupLimiter, optionalAuth, getOrder);
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
router.post(
  "/orders",
  checkoutLimiter,
  guestCheckoutLimiter,
  optionalAuth,
  validateRequest(orderSchema),
  createOrder
);

module.exports = router;
