const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { checkoutLimiter, webhookLimiter } = require("../middleware/rateLimit.middleware");
const { orderSchema } = require("../schemas/request.schemas");
const { stripeCheckout, stripeWebhook } = require("../controllers/stripe.controller");

router.post("/checkout-stripe", checkoutLimiter, validateRequest(orderSchema), stripeCheckout);
router.post("/stripe-webhook", webhookLimiter, stripeWebhook);

module.exports = router;
