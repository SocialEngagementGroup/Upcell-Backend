const express = require("express");
const router = express.Router();

const { checkoutLimiter } = require("../middleware/rateLimit.middleware");
const { verifyToken } = require("../middleware/auth.middleware");
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

// verifyToken, not optionalAuth. The checkout page is already behind
// PrivateRoute in the frontend, but that is a client-side guard only — this
// endpoint accepted an anonymous POST and created a real order, and the Clerk
// token the browser was already sending was never read. Without it an order
// carries no record of who placed it, which is both an ownership problem (the
// customer cannot see their own order if they typed a different email) and an
// evidence problem in a chargeback.
// Limiter before verifyToken on purpose: verifyToken calls out to Clerk to
// resolve the user, so putting it first would let an unauthenticated flood
// drive one outbound Clerk request per attempt.
router.post(
  "/prepare-payment",
  checkoutLimiter,
  verifyToken,
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
