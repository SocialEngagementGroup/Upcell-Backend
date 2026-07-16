const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { checkoutLimiter } = require("../middleware/rateLimit.middleware");
const { orderSchema } = require("../schemas/request.schemas");
const { paypalCheckout, capturePayment } = require("../controllers/checkout.controller");

router.post("/", checkoutLimiter, validateRequest(orderSchema), paypalCheckout);
router.post("/capture", checkoutLimiter, capturePayment);

module.exports = router;
