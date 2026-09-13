const express = require("express");
const router = express.Router();

const { checkoutLimiter, guestCheckoutLimiter } = require("../middleware/rateLimit.middleware");
const { optionalAuth } = require("../middleware/auth.middleware");
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
// optionalAuth, not verifyToken. Requiring an account to buy a phone is the
// biggest thing between a visitor and a sale, and the account it forced them
// to make unlocked nothing but the order they were already placing.
//
// A signed-in customer still gets their Clerk id on the order, which is what
// ownership is checked against. A guest gets a token in their receipt email
// instead — see services/guestOrder.js.
//
// Both limiters, in this order: checkoutLimiter covers everyone, and
// guestCheckoutLimiter adds a tighter ceiling that skips signed-in callers.
// Both sit before optionalAuth, because optionalAuth calls out to Clerk to
// resolve a token and a flood must not drive one outbound request per attempt.
router.post(
  "/prepare-payment",
  checkoutLimiter,
  guestCheckoutLimiter,
  optionalAuth,
  validateRequest(orderSchema),
  preparePayment
);

// Deliberately no rate limiter. The bank posts from a small fixed set of IPs,
// so an IP-keyed limit is shared across every customer at once — the 61st
// confirmation in a minute would be rejected, and a rejected confirmation is
// money taken with no record of it. The signature is the authentication here.
router.post("/merchant-post", form, merchantPost);

router.post("/response", form, paymentResponse);

// The portal's "Custom Cancel Response Page" is a separate setting from the
// Transaction Response Page above — it fires when the customer clicks Cancel
// on the hosted page itself, before any transaction completes, and posts to
// its own configured URL rather than to /response. It was left "Hosted By
// <TOKEN>" (Cybersource's own page) until now, so this is a new delivery,
// not a duplicate of one /response already received. Same handler as
// /response on purpose: the payload is the same signed shape, and
// paymentResponse already has a decision === "CANCEL" branch — verify
// signature, release the stock hold by transaction_uuid, redirect to the
// cart — written for exactly this notification.
router.post("/cancel", form, paymentResponse);

module.exports = router;
