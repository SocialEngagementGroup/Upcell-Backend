const { Schema, model, models } = require("mongoose");

const statusEnum = [
  "Processing",
  "Shipped",
  "Delivered",
  "Returned",
  "Refunded",
  "payment failed",
];
const paidWithEnum = ["Stripe", "Paypal", "Card", "Manual"];
const shippingEnum = ["standard", "priority", "express"];

const OrderSchema = new Schema(
  {
    line_items: Object,
    name: String,
    email: String,
    phone: String,
    city: String,
    postal: String,
    street: String,
    country: String,
    shipping: { type: String, enum: shippingEnum },
    paid: Boolean,
    status: { type: String, enum: statusEnum },
    paidWith: { type: String, enum: paidWithEnum },
    paypalId: String,
    stripeSessionId: String,
  },
  { timestamps: true }
);

// sparse: true — Manual/other-gateway orders don't have these fields at all,
// and a plain unique index would treat every one of those missing values as
// the same null and collide. sparse skips indexing docs where the field is
// absent, so uniqueness only applies to orders that actually have an ID.
OrderSchema.index({ paypalId: 1 }, { unique: true, sparse: true });
OrderSchema.index({ stripeSessionId: 1 }, { unique: true, sparse: true });
OrderSchema.index({ email: 1, paid: 1 });
OrderSchema.index({ status: 1, updatedAt: -1 });
OrderSchema.index({ createdAt: 1 });

const Order = models?.Order || model("Order", OrderSchema);

module.exports = Order;
