const { Schema, model, models } = require("mongoose");

const EmailConfigSchema = new Schema(
  {
    tradeInAdminEmail: {
      type: String,
      default: () => process.env.ADMIN_NOTIFICATION_EMAIL,
    },
    enableCustomerEmails: { type: Boolean, default: true },
    enableAdminEmails: { type: Boolean, default: true },
    // Global on/off switch for the 5xx alert email + Google Chat webhook in
    // error.middleware.js — lets an admin mute both while intentionally
    // testing something expected to error, without touching code or env vars.
    enableErrorAlerts: { type: Boolean, default: true },
    sentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const EmailConfig = models?.EmailConfig || model("EmailConfig", EmailConfigSchema);

module.exports = { EmailConfig };
