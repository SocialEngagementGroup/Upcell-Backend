const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { reviewSchema, reviewModerationSchema } = require("../schemas/request.schemas");
const {
  createReview,
  getProductReviews,
  getMyReviews,
  getAdminReviews,
  moderateReview,
} = require("../controllers/review.controller");

// What customers said about a product family. Public, approved only.
router.get("/products/:parentId/reviews", validateObjectIdParam("parentId"), getProductReviews);

// Writing one. Signed in, their own delivered order, and the device on it —
// all three are checked in the controller, and together they are what the
// "Verified purchase" badge means.
//
// Rate limited despite needing a login: an account is free, and a review form
// is a text box that ends up on a public page.
router.post("/reviews", verifyToken, publicFormLimiter, validateRequest(reviewSchema), createReview);

// What this customer has already written, so My Account can offer the ones
// they have not.
router.get("/reviews/mine", verifyToken, getMyReviews);

router.get("/admin-reviews", verifyToken, requireAdmin, getAdminReviews);
router.patch(
  "/admin-reviews/:id",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(reviewModerationSchema),
  moderateReview
);

module.exports = router;
