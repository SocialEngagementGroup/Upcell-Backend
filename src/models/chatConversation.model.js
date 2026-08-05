const mongoose = require("mongoose");

const chatConversationSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    trim: true,
  },
  role: {
    type: String,
    enum: ["user", "assistant"],
    required: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  escalate: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

// Auto-expire chat logs after 90 days, same retention window as AnalyticsEvent.
chatConversationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
chatConversationSchema.index({ sessionId: 1, createdAt: 1 });

const ChatConversation = mongoose.model("chat_conversation", chatConversationSchema);

module.exports = ChatConversation;
