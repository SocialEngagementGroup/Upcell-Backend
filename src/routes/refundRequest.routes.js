const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const {
  refundRequestCreateSchema,
  refundRequestStatusSchema,
  returnLabelSchema,
  inspectionSubmitSchema,
  revisedOfferSchema,
  settlementSchema,
} = require("../schemas/request.schemas");
const {
  getRefundableItems,
  createRefundRequest,
  getMyRefundRequests,
  getAdminRefundRequests,
  updateRefundRequestStatus,
  recordReturnLabel,
  lookupReturnRequest,
  getInspectionChecklist,
  submitInspection,
  offerRevisedRefund,
  respondToRevisedOffer,
  settleRefundRequest,
  getReturnsDashboard,
  shipRejectedDeviceBack,
  markShipBackUndeliverable,
  getShipBackQueue,
} = require("../controllers/refundRequest.controller");

// Customer. Signed in only — guest returns by order id and email come later,
// and every one of these reads or writes against someone's own order.
router.get("/orders/:id/refundable", verifyToken, getRefundableItems);
router.get("/refund-requests/mine", verifyToken, getMyRefundRequests);
// Rate limited like the other public forms: this one writes a record and
// notifies staff, so a stuck submit button should not create fifty.
router.post(
  "/refund-requests",
  publicFormLimiter,
  verifyToken,
  validateRequest(refundRequestCreateSchema),
  createRefundRequest
);

// Staff.
// Finding a parcel on the receiving bench. Before :status, because Express
// matches in order and "lookup" would otherwise be read as a status name.
router.get("/admin-refund-requests/lookup", verifyToken, requireAdmin, lookupReturnRequest);

router.get("/admin-refund-requests/:status", verifyToken, requireAdmin, getAdminRefundRequests);
router.patch(
  "/admin-refund-requests/:id/status",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(refundRequestStatusSchema),
  updateRefundRequestStatus
);

router.patch(
  "/admin-refund-requests/:id/label",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(returnLabelSchema),
  recordReturnLabel
);

// The list an inspector answers, served from the same place the validation
// reads it, so the two can never drift apart.
router.get("/admin-return-inspection-checklist", verifyToken, requireAdmin, getInspectionChecklist);

router.patch(
  "/admin-refund-requests/:id/inspection",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(inspectionSubmitSchema),
  submitInspection
);

router.patch(
  "/admin-refund-requests/:id/revised-offer",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(revisedOfferSchema),
  offerRevisedRefund
);

// The customer answering from the link in their email. No verifyToken on
// purpose: this arrives on a phone months after they last signed in, and a
// login wall here is how an offer times out and a device gets posted back for
// no reason. The unguessable token on the request is what authorises it, and it
// grants exactly this one return. Rate limited like the other public writes.
router.post(
  "/returns/:id/:decision",
  publicFormLimiter,
  validateObjectIdParam(),
  respondToRevisedOffer
);

// What is waiting on us, and what we have already missed.
router.get("/admin-returns-dashboard", verifyToken, requireAdmin, getReturnsDashboard);

router.patch(
  "/admin-refund-requests/:id/settle",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(settlementSchema),
  settleRefundRequest
);

// Devices waiting to go back, and ones that came back undelivered. Its own
// queue rather than a filter, because a rejected phone with no owner is what
// quietly accumulates.
router.get("/admin-return-ship-backs", verifyToken, requireAdmin, getShipBackQueue);

router.patch(
  "/admin-refund-requests/:id/ship-back",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(returnLabelSchema),
  shipRejectedDeviceBack
);

router.patch(
  "/admin-refund-requests/:id/undeliverable",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  markShipBackUndeliverable
);

module.exports = router;
