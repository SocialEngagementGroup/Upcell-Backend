const { Schema, model, models } = require("mongoose");

// Separate from AuditLog on purpose — AuditLog requires an actorId/
// actorEmail because it's for admin-driven actions. Webhook events aren't
// triggered by a logged-in admin, so forcing them through that schema would
// mean faking an "actor" that doesn't exist. This is the payment-specific
// trail: what did we receive from Stripe/PayPal, and what did we do with it.
const eventTypeEnum = [
  "webhook_received",
  "signature_rejected",
  "marked_paid",
  "refunded",
  "config_error",
];
const gatewayEnum = ["Stripe", "Paypal"];

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
