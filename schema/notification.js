const { Schema, model, models } = require("mongoose");

const notificationTypeEnum = ["trade-in", "order", "wholesale", "contact"];

const NotificationSchema = new Schema(
  {
    type: { type: String, enum: notificationTypeEnum, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: String,
    relatedId: Schema.Types.ObjectId,
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ isRead: 1, createdAt: -1 });

const Notification = models?.Notification || model("Notification", NotificationSchema);

module.exports = { Notification, notificationTypeEnum };
