const crypto = require("crypto");
const ChatConversation = require("../models/chatConversation.model");
const { getAiProvider } = require("../services/aiProvider");
const { SYSTEM_PROMPT } = require("../services/chat/systemPrompt");
const { redactSensitiveInput, screenModelReply, shouldEscalate } = require("../services/chat/moderation");
const { getChatSettings, claimDailyRequestBudget, recordTokenUsage } = require("../services/chat/chatSettingsService");

// How many recent turns (user + assistant combined) to feed back to the
// model as conversation context.
const HISTORY_LIMIT = 10;

const FALLBACK_REPLY = "Sorry, I didn't quite catch that — could you rephrase, or tap \"Contact our support team\" below?";
const UNAVAILABLE_REPLY = "Chat support is temporarily unavailable — please reach us at usa.Upcells@gmail.com or through the Support page, and we'll get back to you.";
const SAFETY_BLOCKED_REPLY = "I'm not able to help with that one — let me connect you with our support team instead.";

// Exactly one of sessionId/userId, matching the model's pre-validate
// invariant — never a value taken from the request body (SEG F-01).
function identityFilter(identity) {
  return identity.type === "user" ? { userId: identity.id } : { sessionId: identity.id };
}

// SEG F-07 escalation trigger: how many of the most recent assistant turns
// in a row ended in the fallback "didn't catch that" reply.
async function countConsecutiveUnanswered(identity) {
  const recentAssistantTurns = await ChatConversation.find({ ...identityFilter(identity), role: "assistant" })
    .sort({ createdAt: -1, _id: -1 })
    .limit(3)
    .lean();

  let count = 0;
  for (const turn of recentAssistantTurns) {
    if (turn.message === FALLBACK_REPLY) count += 1;
    else break;
  }
  return count;
}

// SEG §11: structured, per-request logging. Never logs message content,
// the API key, or anything redacted — only metadata needed to investigate
// abuse/cost/quality after the fact.
function logChatRequest(fields) {
  console.log(JSON.stringify({ event: "chat_request", ...fields }));
}

async function sendChatMessage(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const identity = req.chatIdentity;

  try {
    // SEG §06 kill switch — disables the widget with no deploy.
    const settings = await getChatSettings();
    if (settings.killSwitchEnabled) {
      logChatRequest({ requestId, identityType: identity.type, outcome: "kill_switch" });
      return res.status(200).json({ reply: UNAVAILABLE_REPLY, escalate: true });
    }

    // SEG §06 daily budget — claimed before the model is ever called.
    const budget = await claimDailyRequestBudget();
    if (!budget.allowed) {
      logChatRequest({ requestId, identityType: identity.type, outcome: "daily_budget_exceeded" });
      return res.status(200).json({ reply: UNAVAILABLE_REPLY, escalate: true });
    }

    // SEG F-06: redact before this ever touches the database or Gemini.
    const { text: cleanMessage, redacted } = redactSensitiveInput(req.body.message);

    await ChatConversation.create({
      ...identityFilter(identity),
      role: "user",
      message: cleanMessage,
      redacted,
    });

    // SEG F-11: secondary sort key so same-millisecond writes still order
    // deterministically, instead of relying on createdAt alone.
    const recentTurnsDesc = await ChatConversation.find(identityFilter(identity))
      .sort({ createdAt: -1, _id: -1 })
      .limit(HISTORY_LIMIT)
      .lean();
    const history = recentTurnsDesc
      .reverse()
      .map((turn) => ({ role: turn.role, content: turn.message }));

    const provider = getAiProvider();
    const result = await provider.complete({ systemPrompt: SYSTEM_PROMPT, history });

    if (result.usage) {
      recordTokenUsage(result.usage).catch(() => {}); // best-effort, never blocks the reply
    }

    let reply = result.blockedBySafety ? SAFETY_BLOCKED_REPLY : (result.text || FALLBACK_REPLY);

    // SEG F-05: screen before display — never let an invented discount or a
    // leaked system-prompt fragment reach the customer.
    const screened = screenModelReply(reply);
    reply = screened.text;

    const priorUnanswered = await countConsecutiveUnanswered(identity);
    const isFallback = reply === FALLBACK_REPLY;
    const { escalate, reason: escalateReason } = shouldEscalate({
      userMessage: cleanMessage,
      modelReplyBlocked: screened.blocked || result.blockedBySafety,
      consecutiveUnansweredTurns: isFallback ? priorUnanswered + 1 : priorUnanswered,
    });

    await ChatConversation.create({ ...identityFilter(identity), role: "assistant", message: reply, escalate });

    logChatRequest({
      requestId,
      identityType: identity.type,
      latencyMs: Date.now() - startedAt,
      finishReason: result.finishReason,
      blockedBySafety: result.blockedBySafety,
      outputScreened: screened.blocked,
      inputRedacted: redacted,
      escalate,
      escalateReason,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      outcome: "ok",
    });

    res.status(200).json({ reply, escalate });
  } catch (error) {
    logChatRequest({
      requestId,
      identityType: identity?.type,
      latencyMs: Date.now() - startedAt,
      outcome: "error",
      errorStatus: error?.status || null,
    });
    next(error);
  }
}

module.exports = { sendChatMessage };
