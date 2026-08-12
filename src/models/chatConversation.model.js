const mongoose = require("mongoose");

const chatConversationSchema = new mongoose.Schema({
  // Exactly one of these is set, never both. Server-issued identity only
  // (SEG F-01): sessionId = guest, a signed cookie value minted by
  // chatSession.middleware.js; userId = the authenticated Clerk user id.
  // The client never gets to propose either value.
  sessionId: {
    type: String,
    trim: true,
  },
  userId: {
    type: String,
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
  // Set when redactSensitiveInput() found and masked something in this
  // message before it was ever written here (SEG F-06).
  redacted: {
    type: Boolean,
    default: false,
  },
  escalate: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

chatConversationSchema.pre("validate", function enforceSingleIdentity(next) {
  const hasSession = Boolean(this.sessionId);
  const hasUser = Boolean(this.userId);
  if (hasSession === hasUser) {
    next(new Error("chat_conversation requires exactly one of sessionId or userId"));
    return;
  }
  next();
});

// Auto-expire chat logs after 90 days, same retention window as AnalyticsEvent.
chatConversationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
chatConversationSchema.index({ sessionId: 1, createdAt: 1 });
chatConversationSchema.index({ userId: 1, createdAt: 1 });

const ChatConversation = mongoose.model("chat_conversation", chatConversationSchema);

module.exports = ChatConversation;
