const { Schema, model, models } = require("mongoose");

const EmailConfigSchema = new Schema(
  {
    tradeInAdminEmail: {
      type: String,
      default: () =>
        process.env.TRADE_ORDER_NOTIFICATION_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL,
    },
    enableCustomerEmails: { type: Boolean, default: true },
    enableAdminEmails: { type: Boolean, default: true },
    sentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const EmailConfig = models?.EmailConfig || model("EmailConfig", EmailConfigSchema);

module.exports = { EmailConfig };
