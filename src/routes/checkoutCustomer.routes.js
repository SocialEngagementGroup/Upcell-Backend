const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { checkoutLimiter, webhookLimiter } = require("../middleware/rateLimit.middleware");
const { orderSchema, captureSchema } = require("../schemas/request.schemas");
const { paypalCheckout, capturePayment, paypalWebhook } = require("../controllers/checkout.controller");

router.post("/", checkoutLimiter, validateRequest(orderSchema), paypalCheckout);
router.post("/capture", checkoutLimiter, validateRequest(captureSchema), capturePayment);
// Called by PayPal's servers, not the browser — webhookLimiter is generous
// (60/min) so it never touches real gateway traffic, it only blunts a flood
// of garbage/unsigned POSTs, each of which otherwise costs an outbound
// signature-verification call to PayPal. No orderID-style body validation
// here — the payload shape is PayPal's webhook event, not our order form.
router.post("/webhook", webhookLimiter, paypalWebhook);

module.exports = router;
