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
  // The five below: the first three were already being emitted by the BOA
  // controller without ever being listed here, so each one failed enum
  // validation and was swallowed by logPaymentEvent's catch — exactly the
  // failure the comment above warns about. The events that most needed
  // recording were the ones that vanished: an unknown_decision is by
  // definition a gap in the handler, and nothing was left to show it.
  //
  // The bank answered REVIEW. Nothing paid, nothing sold, and the stock hold
  // is deliberately left on its ordinary twenty-minute timer.
  "entered_review",
  // The customer clicked Cancel on the hosted page. Releases the hold.
  "customer_cancelled",
  // A decision string this handler has no mapping for. Always investigate.
  "unknown_decision",
  // A review came back ACCEPT after the device had already sold to someone
  // else. Money taken, nothing to ship. Never silent.
  "oversell_collision",
  // A review nobody actioned inside the pending window, closed automatically.
  // This does NOT reverse the authorisation — see reconciliation.js.
  "review_auto_rejected",
];
const gatewayEnum = ["BankOfAmerica"];

const PaymentEventLogSchema = new Schema(
  {
    gateway: { type: String, enum: gatewayEnum, required: true },
    eventType: { type: String, enum: eventTypeEnum, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    gatewayReference: String, // the bank's transaction_id
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true }
);

PaymentEventLogSchema.index({ createdAt: -1 });
PaymentEventLogSchema.index({ orderId: 1 });

const PaymentEventLog = models?.PaymentEventLog || model("PaymentEventLog", PaymentEventLogSchema);

module.exports = PaymentEventLog;
