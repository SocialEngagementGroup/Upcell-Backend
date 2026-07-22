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

// Webhook endpoints are called by PayPal/Stripe's own infrastructure, not a
// single customer IP, so this must stay far above real gateway traffic. It
// exists only to blunt a flood of garbage/unsigned POSTs, each of which
// otherwise costs an outbound signature-verification call to PayPal.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

module.exports = { publicFormLimiter, checkoutLimiter, analyticsLimiter, cartLimiter, webhookLimiter };
