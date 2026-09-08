const { Schema, model, models } = require("mongoose");

const NewsletterSubscriberSchema = new Schema(
  {
    // Uniqueness is declared once, on the explicit index below. Setting
    // `unique: true` here as well describes the same index twice and makes
    // Mongoose log a duplicate-index warning on every startup.
    email: { type: String, required: true, lowercase: true, trim: true },
    source: { type: String, default: "footer" },
    status: { type: String, enum: ["Active", "Unsubscribed"], default: "Active" },
  },
  { timestamps: true }
);

NewsletterSubscriberSchema.index({ email: 1 }, { unique: true });
NewsletterSubscriberSchema.index({ status: 1, createdAt: -1 });

const NewsletterSubscriber = models?.NewsletterSubscriber || model("NewsletterSubscriber", NewsletterSubscriberSchema);

module.exports = NewsletterSubscriber;
