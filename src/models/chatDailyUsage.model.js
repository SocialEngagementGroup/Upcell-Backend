const mongoose = require("mongoose");

// One document per UTC calendar day — SEG §06's "per-deployment, per-day"
// cost ceiling, checked before every Gemini call. A new document per date
// means there's no rollover logic to get wrong at midnight.
const chatDailyUsageSchema = new mongoose.Schema({
  date: {
    type: String, // "YYYY-MM-DD", UTC
    required: true,
    unique: true,
  },
  requestCount: {
    type: Number,
    default: 0,
  },
  inputTokens: {
    type: Number,
    default: 0,
  },
  outputTokens: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// 90-day auto-cleanup — this is operational telemetry, not something that
// needs to outlive the retention window everything else in chat uses.
chatDailyUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

const ChatDailyUsage = mongoose.model("chat_daily_usage", chatDailyUsageSchema);

module.exports = ChatDailyUsage;
