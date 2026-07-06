const mongoose = require("mongoose");

const analyticsEventSchema = new mongoose.Schema({
  category: {
    type: String,
    enum: ["form_submit", "form_dropoff", "form_engagement", "admin_api_error"],
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ["started", "success", "failed", "dropoff", "error"],
    default: "started",
  },
  formName: {
    type: String,
    trim: true,
  },
  path: {
    type: String,
    trim: true,
  },
  message: {
    type: String,
    trim: true,
  },
  sessionId: {
    type: String,
    trim: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

// Auto-expire analytics events after 90 days so this collection doesn't grow forever.
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
analyticsEventSchema.index({ category: 1, createdAt: 1 });
analyticsEventSchema.index({ status: 1, createdAt: 1 });
analyticsEventSchema.index({ formName: 1, createdAt: 1 });

const AnalyticsEvent = mongoose.model("analytics_event", analyticsEventSchema);

module.exports = AnalyticsEvent;
