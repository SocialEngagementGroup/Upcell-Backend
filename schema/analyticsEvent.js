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

const AnalyticsEvent = mongoose.model("analytics_event", analyticsEventSchema);

module.exports = AnalyticsEvent;
