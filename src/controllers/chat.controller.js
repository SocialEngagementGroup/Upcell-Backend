const crypto = require("crypto");
const ChatConversation = require("../models/chatConversation.model");
const { getAiProvider } = require("../services/aiProvider");
const { SYSTEM_PROMPT } = require("../services/chat/systemPrompt");
const { redactSensitiveInput, screenModelReply, shouldEscalate } = require("../services/chat/moderation");
const { getChatSettings, claimDailyRequestBudget, recordTokenUsage } = require("../services/chat/chatSettingsService");
const {
  retrieveKnowledge,
  buildKnowledgeBlock,
  detectShortCircuitTopic,
  shortCircuitReply,
  detectConflictTopic,
} = require("../services/chat/siteKnowledge");
const { getCatalogueSnapshot, scopeToMessage } = require("../services/chat/catalogueService");
const { notifyUpstreamFailure, notifyEscalation } = require("../services/chat/chatAlerts");

// How many recent turns (user + assistant combined) to feed back to the
// model as conversation context.
const HISTORY_LIMIT = 10;

const FALLBACK_REPLY = "Sorry, I didn't quite catch that — could you rephrase, or tap \"Contact our support team\" below?";
const UNAVAILABLE_REPLY = "Chat support is temporarily unavailable — please reach us at usa.Upcells@gmail.com or through the Support page, and we'll get back to you.";
const SAFETY_BLOCKED_REPLY = "I'm not able to help with that one — let me connect you with our support team instead.";
// SEG §07: a topic whose wording the client hasn't approved yet is answered by
// a human, not improvised by the model — and without spending a model call.
const UNAPPROVED_TOPIC_REPLY = "I don't want to give you the wrong details on that one — let me put you in touch with our support team, who can confirm it properly.";
// SEG §05/§09: payment or ID data was volunteered. Say so, never echo it back.
const SENSITIVE_DATA_REPLY = "For your security I've removed those details — please never share card, bank, or ID numbers in chat. Our support team can help you through a secure channel.";

// Exactly one of sessionId/userId, matching the model's pre-validate
// invariant — never a value taken from the request body (SEG F-01).
function identityFilter(identity) {
  return identity.type === "user" ? { userId: identity.id } : { sessionId: identity.id };
}

// SEG F-07 escalation trigger: how many of the most recent assistant turns in a
// row ended in the fallback "didn't catch that" reply. Reads the history the
// request already loaded (newest first) instead of issuing its own query.
function countConsecutiveUnanswered(recentTurnsDesc) {
  let count = 0;
  for (const turn of recentTurnsDesc) {
    if (turn.role !== "assistant") continue;
    if (turn.message === FALLBACK_REPLY) count += 1;
    else break;
  }
  return count;
}

// A short, human-speakable handle for one handoff. It goes to the customer and
// to the support space at the same time, so the first thing a colleague can say
// is "yes, I have it" instead of "what were you asking about?". Derived from the
// request id — no extra state, and unique for the same reason that is.
function escalationReference(requestId) {
  return `UP-${requestId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
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

    // SEG §07/§09: decide server-side, before any model call, whether this
    // question is even the model's to answer. Volunteered payment/ID data and
    // topics with no approved wording are handled from a fixed string — which
    // also means the most common probing messages cost nothing.
    const blockedTopic = detectShortCircuitTopic(cleanMessage);

    if (redacted || blockedTopic) {
      const reply = redacted ? SENSITIVE_DATA_REPLY : (shortCircuitReply(blockedTopic) || UNAPPROVED_TOPIC_REPLY);
      await ChatConversation.create({
        ...identityFilter(identity), role: "user", message: cleanMessage, redacted, status: "complete",
      });
      await ChatConversation.create({
        ...identityFilter(identity), role: "assistant", message: reply, escalate: true, status: "complete",
      });
      logChatRequest({
        requestId,
        identityType: identity.type,
        latencyMs: Date.now() - startedAt,
        inputRedacted: redacted,
        topic: blockedTopic,
        escalate: true,
        escalateReason: redacted ? "sensitive_data_volunteered" : `unapproved_topic:${blockedTopic}`,
        outcome: "short_circuited_no_model_call",
      });
      return res.status(200).json({ reply, escalate: true });
    }

    // SEG F-11: written as pending, promoted to complete only once its reply
    // exists — a failed model call must not leave a permanently unanswered
    // turn that skews every later request.
    const userTurn = await ChatConversation.create({
      ...identityFilter(identity),
      role: "user",
      message: cleanMessage,
      redacted,
      status: "pending",
    });

    // Completed turns only, and the secondary sort key keeps same-millisecond
    // writes deterministic instead of relying on createdAt alone (SEG F-11).
    const recentTurnsDesc = await ChatConversation.find({ ...identityFilter(identity), status: "complete" })
      .sort({ createdAt: -1, _id: -1 })
      .limit(HISTORY_LIMIT - 1)
      .lean();
    const history = [
      ...recentTurnsDesc.reverse().map((turn) => ({ role: turn.role, content: turn.message })),
      { role: "user", content: cleanMessage },
    ];

    // SEG §07 ("give it a real source"): the facts for this specific question,
    // selected server-side from the website's own published content, plus a
    // cached snapshot of the public product catalogue. The model still has no
    // database access of its own — the server builds both blocks and the model
    // only reads them, so nothing customer-specific is reachable.
    const knowledge = retrieveKnowledge(cleanMessage);
    const catalogue = await getCatalogueSnapshot();
    // The last couple of turns come along so a follow-up like "what's the price
    // and features?" still resolves to the model just discussed.
    const recentText = history.slice(-4, -1).map((turn) => turn.content).join(" ");
    const scopedCatalogue = scopeToMessage(catalogue, cleanMessage, recentText);
    const systemPrompt = [
      SYSTEM_PROMPT,
      buildKnowledgeBlock(knowledge),
      scopedCatalogue?.block,
    ].filter(Boolean).join("\n\n");

    const provider = getAiProvider();
    const result = await provider.complete({ systemPrompt, history });

    if (result.usage) {
      recordTokenUsage(result.usage).catch(() => {}); // best-effort, never blocks the reply
    }

    let reply = result.blockedBySafety ? SAFETY_BLOCKED_REPLY : (result.text || FALLBACK_REPLY);

    // SEG F-05: screen before display. A price is allowed through only if the
    // live catalogue actually contains it — real figures pass, invented ones
    // are replaced.
    const screened = screenModelReply(reply, {
      allowedPrices: catalogue?.allowedPrices || null,
      userMessage: cleanMessage,
    });
    reply = screened.text;

    // Derived from the history already in memory rather than a second query —
    // one less round trip on the customer's critical path.
    const priorUnanswered = countConsecutiveUnanswered(recentTurnsDesc);
    const isFallback = reply === FALLBACK_REPLY;
    const { escalate, reason: escalateReason } = shouldEscalate({
      userMessage: cleanMessage,
      modelReplyBlocked: screened.blocked || result.blockedBySafety,
      consecutiveUnansweredTurns: isFallback ? priorUnanswered + 1 : priorUnanswered,
      inputRedacted: redacted,
      // A question about a fact the website contradicts itself on still gets
      // the process answer, but always with a human route attached (SEG §07).
      blockedTopic: detectConflictTopic(cleanMessage),
    });

    // SEG F-07: a handoff nobody is told about is not a handoff. The reference
    // goes to the customer and to the support space together.
    const reference = escalate ? escalationReference(requestId) : null;
    if (escalate) {
      notifyEscalation({
        reference,
        reason: escalateReason,
        identityType: identity.type,
        lastMessage: cleanMessage,
      });
    }

    // Independent writes, so they go together rather than one after the other.
    await Promise.all([
      ChatConversation.create({
        ...identityFilter(identity), role: "assistant", message: reply, escalate, status: "complete",
      }),
      // The turn is only complete once its reply is on record (SEG F-11).
      ChatConversation.updateOne({ _id: userTurn._id }, { $set: { status: "complete" } }),
    ]);

    logChatRequest({
      requestId,
      identityType: identity.type,
      latencyMs: Date.now() - startedAt,
      model: result.model,
      finishReason: result.finishReason,
      blockedBySafety: result.blockedBySafety,
      outputScreened: screened.blocked,
      outputScreenReasons: screened.reasons,
      inputRedacted: redacted,
      // Which site-content entries grounded this answer — the thing you need
      // when a customer says "your bot told me…" (SEG §07).
      knowledgeUsed: knowledge.map((entry) => entry.id),
      escalate,
      escalateReason,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      outcome: "ok",
    });

    res.status(200).json({ reply, escalate, reference });
  } catch (error) {
    logChatRequest({
      requestId,
      identityType: identity?.type,
      latencyMs: Date.now() - startedAt,
      outcome: "error",
      errorStatus: error?.status || null,
    });
    // SEG §11: a failing assistant is the earliest signal of a quota problem,
    // a revoked key or a model ID that no longer exists — it should not be
    // something only customers notice. Throttled inside the alert service.
    notifyUpstreamFailure({ status: error?.status });
    next(error);
  }
}

module.exports = { sendChatMessage };
