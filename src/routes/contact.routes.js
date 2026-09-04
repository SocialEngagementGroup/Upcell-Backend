const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { contactSubmissionSchema } = require("../schemas/request.schemas");
const {
  createContactSubmission,
  getAdminContactSubmissions,
  updateContactSubmissionStatus,
  deleteContactSubmission,
} = require("../controllers/contact.controller");

router.post(
  "/contact-submissions",
  publicFormLimiter,
  validateRequest(contactSubmissionSchema),
  createContactSubmission
);
router.get("/admin-contact-submissions/:filter", verifyToken, requireAdmin, getAdminContactSubmissions);
router.patch(
  "/contact-submissions/:id/status",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  updateContactSubmissionStatus
);
router.delete(
  "/contact-submissions/:id",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  deleteContactSubmission
);

module.exports = router;
