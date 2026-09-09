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

module.exports = router;
