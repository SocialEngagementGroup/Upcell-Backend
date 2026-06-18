const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { orderSchema } = require("../schemas/request.schemas");
const { stripeCheckout, stripeWebhook } = require("../controllers/stripe.controller");

router.post("/checkout-stripe", validateRequest(orderSchema), stripeCheckout);
router.post("/stripe-webhook", stripeWebhook);

module.exports = router;
