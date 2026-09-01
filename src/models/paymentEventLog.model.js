const { Schema, model, models } = require("mongoose");

// Separate from AuditLog on purpose — AuditLog requires an actorId/
// actorEmail because it's for admin-driven actions. Webhook events aren't
// triggered by a logged-in admin, so forcing them through that schema would
// mean faking an "actor" that doesn't exist. This is the payment-specific
// trail: what did we receive from Stripe/PayPal, and what did we do with it.
// eventType is a required enum, and logPaymentEvent is fire-and-forget — a
// value missing from this list fails validation and is swallowed by that
// catch, so the event that most needed recording is the one that vanishes.
// Add the value here in the same change that starts emitting it.
const eventTypeEnum = [
  "webhook_received",
  "signature_rejected",
  "marked_paid",
  "refunded",
  "config_error",
  // The bank confirmed a payment we cannot tie to an order. Money has moved
  // and nothing in the shop records it — the highest-priority alert here.
  "unmatched_confirmation",
  // Authorised amount differs from what the order is worth. Not marked paid.
  "amount_mismatch",
  // A retried confirmation that lost the race to claim an already-settled
  // order. Expected and harmless; recorded so retry storms stay visible.
  "duplicate_confirmation",
];
const gatewayEnum = ["Stripe", "Paypal", "BankOfAmerica"];

const PaymentEventLogSchema = new Schema(
  {
    gateway: { type: String, enum: gatewayEnum, required: true },
    eventType: { type: String, enum: eventTypeEnum, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    gatewayReference: String, // paypalId / stripeSessionId / gateway event id
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true }
);

PaymentEventLogSchema.index({ createdAt: -1 });
PaymentEventLogSchema.index({ orderId: 1 });

const PaymentEventLog = models?.PaymentEventLog || model("PaymentEventLog", PaymentEventLogSchema);

module.exports = PaymentEventLog;
