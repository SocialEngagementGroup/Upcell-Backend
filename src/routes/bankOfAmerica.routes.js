const express = require("express");
const router = express.Router();

const { checkoutLimiter } = require("../middleware/rateLimit.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { orderSchema } = require("../schemas/request.schemas");
const {
  preparePayment,
  merchantPost,
  paymentResponse,
} = require("../controllers/bankOfAmerica.controller");

// Secure Acceptance posts old-style form data, not JSON. app.js only mounts
// express.json(), which silently skips a urlencoded body and leaves req.body
// empty — so these two routes parse their own. Mounted here rather than
// globally so no existing route changes behaviour.
const form = express.urlencoded({ extended: false });

router.post(
  "/prepare-payment",
  checkoutLimiter,
  validateRequest(orderSchema),
  preparePayment
);

// Deliberately no rate limiter. The bank posts from a small fixed set of IPs,
// so an IP-keyed limit is shared across every customer at once — the 61st
// confirmation in a minute would be rejected, and a rejected confirmation is
// money taken with no record of it. The signature is the authentication here.
router.post("/merchant-post", form, merchantPost);

router.post("/response", form, paymentResponse);

module.exports = router;
