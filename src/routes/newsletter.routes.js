const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { newsletterSubscriberSchema } = require("../schemas/request.schemas");
const {
  createNewsletterSubscriber,
  getAdminNewsletterSubscribers,
  updateNewsletterStatus,
  deleteNewsletterSubscriber,
} = require("../controllers/newsletter.controller");

router.post("/newsletter-subscribers", validateRequest(newsletterSubscriberSchema), createNewsletterSubscriber);
router.get("/admin-newsletter-subscribers/:filter", verifyToken, requireAdmin, getAdminNewsletterSubscribers);
router.patch("/newsletter-subscribers/:id/status", verifyToken, requireAdmin, updateNewsletterStatus);
router.delete("/newsletter-subscribers/:id", verifyToken, requireAdmin, deleteNewsletterSubscriber);

module.exports = router;
