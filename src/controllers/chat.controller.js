const ChatConversation = require("../models/chatConversation.model");
const { getAiProvider } = require("../services/aiProvider");
const { SYSTEM_PROMPT } = require("../services/chat/systemPrompt");

// How many recent turns (user + assistant combined) to feed back to the
// model as conversation context. Escalation rules land in a later step.
const HISTORY_LIMIT = 10;

async function sendChatMessage(req, res, next) {
  try {
    const { message, sessionId } = req.body;

    await ChatConversation.create({ sessionId, role: "user", message });

    const recentTurnsDesc = await ChatConversation.find({ sessionId })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean();
    const history = recentTurnsDesc
      .reverse()
      .map((turn) => ({ role: turn.role, content: turn.message }));

    const provider = getAiProvider();
    const { text } = await provider.complete({ systemPrompt: SYSTEM_PROMPT, history });

    const reply = text || "Sorry, I didn't quite catch that — could you rephrase?";
    const escalate = false;

    await ChatConversation.create({ sessionId, role: "assistant", message: reply, escalate });

    res.status(200).json({ reply, escalate });
  } catch (error) {
    next(error);
  }
}

module.exports = { sendChatMessage };
