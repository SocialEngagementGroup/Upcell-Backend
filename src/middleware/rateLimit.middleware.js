const rateLimit = require("express-rate-limit");

const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Order creation and payment-initiation endpoints: a bit more headroom than a
// plain form (checkout can legitimately be retried after a card decline or
// cart edit), but still tight enough to blunt card-testing/order-spam abuse.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Analytics is fire-and-forget telemetry fired multiple times per page/form
// interaction, often from shared/office IPs — needs a much higher ceiling so
// normal browsing never gets throttled, while still capping runaway abuse.
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Cart-detail lookups happen once per checkout/cart page load.
const cartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Baseline defense-in-depth for every admin-gated route, applied once inside
// requireAdmin (auth.middleware.js) rather than per-route — that way it
// automatically covers all 16 route files with no risk of a new admin route
// forgetting it. 300/15min is deliberately generous: the same lesson learned
// from analyticsLimiter applies here — several admins on one shared
// office/NAT IP must never collectively hit this before any of them notices.
// This is not meant to catch normal usage; it's a ceiling against a
// compromised/leaked admin token or a runaway frontend loop.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

module.exports = { publicFormLimiter, checkoutLimiter, analyticsLimiter, cartLimiter, adminLimiter };
