const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

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

// Chat is a back-and-forth conversation, not a one-shot form — needs enough
// headroom for a real back-and-forth session, but still capped so one visitor
// can't hammer the AI provider (and its per-token cost) in a tight loop.
// SEG §06: demoted to a coarse first filter — IP is the weakest key (carrier
// NAT shares it across real customers), so the per-identity limiter below is
// what actually bounds one visitor.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages. Please wait a moment and try again." },
});

// SEG §06 "per identity" ceiling: keyed by the server-issued identity
// (chatSession.middleware.js's signed guest cookie, or the logged-in user
// id) instead of IP, so clearing cookies/sessionStorage doesn't reset the
// count the way it could when sessionId was client-generated. Must run
// after resolveChatIdentity in the route chain — req.chatIdentity has to
// already exist. The req.ip fallback should be unreachable in practice
// (resolveChatIdentity always sets req.chatIdentity first), but it's kept
// as a defensive default rather than crashing the request — wrapped in
// ipKeyGenerator so IPv6 addresses can't bypass it (express-rate-limit v8
// requires this for any keyGenerator that can fall back to req.ip).
const chatIdentityLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.chatIdentity?.key || ipKeyGenerator(req.ip),
  message: { error: "You've reached today's chat limit. Please try again tomorrow, or reach us at usa.Upcells@gmail.com." },
});

module.exports = {
  publicFormLimiter,
  checkoutLimiter,
  analyticsLimiter,
  cartLimiter,
  webhookLimiter,
  chatLimiter,
  chatIdentityLimiter,
};
