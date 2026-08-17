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
  // SEG F-11 / §08 ("network drops after send"): a user message is written
  // before the model is called, so a failed or timed-out call would otherwise
  // leave a permanently unanswered turn that skews every later request. It is
  // written as "pending" and only promoted to "complete" once its reply has
  // been stored — history is built from completed turns only, so a failure
  // stops distorting the conversation while the message itself is still on
  // record for support/audit purposes.
  status: {
    type: String,
    enum: ["pending", "complete"],
    default: "complete",
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
// status is part of every history read (completed turns only), so it belongs in
// the index rather than being filtered in memory after the fact.
chatConversationSchema.index({ sessionId: 1, status: 1, createdAt: -1 });
chatConversationSchema.index({ userId: 1, status: 1, createdAt: -1 });

const ChatConversation = mongoose.model("chat_conversation", chatConversationSchema);

module.exports = ChatConversation;
