// SEG §11 ("Alert on"): the first sign of chatbot abuse is almost always a
// cost graph, not a security alert — so the budget, the error rate and the kill
// switch have to reach a person on their own.
//
// Delivery reuses the Google Chat webhook the error middleware already posts
// to, deliberately: one more channel nobody has muted yet is worth more than a
// second integration to configure. Nothing here ever includes message content,
// a session id, an API key or anything redacted on write (SEG §11 "never log").
const googleChatWebhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

// Per-alert-kind throttle, so a sustained outage or a budget sitting at 100%
// for the rest of the day produces one message, not one per request.
const ALERT_THROTTLE_MS = 30 * 60 * 1000;
const lastSentAt = new Map();

function shouldSend(key, now = Date.now()) {
  const previous = lastSentAt.get(key) || 0;
  if (now - previous < ALERT_THROTTLE_MS) return false;
  lastSentAt.set(key, now);
  return true;
}

function post(text) {
  if (!googleChatWebhookUrl) return;

  fetch(googleChatWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
    .then((response) => {
      // fetch() only rejects on a network failure — a revoked webhook or a bad
      // payload resolves normally and would otherwise fail silently.
      if (!response.ok) {
        console.error(`Chat alert webhook responded ${response.status}`);
      }
    })
    .catch((error) => {
      console.error("Failed to send chat alert:", error.message);
    });
}

// SEG §11: "Daily token budget at 50%, 80% and 100%. The first two are the
// actionable ones." Called with the request count before and after this
// request so a threshold fires exactly once, on the request that crosses it.
const BUDGET_THRESHOLDS = [50, 80, 100];

function notifyBudgetUsage({ previousCount, currentCount, budget }) {
  if (!budget || budget <= 0) return null;

  const previousPercent = (previousCount / budget) * 100;
  const currentPercent = (currentCount / budget) * 100;

  const crossed = BUDGET_THRESHOLDS.filter(
    (threshold) => previousPercent < threshold && currentPercent >= threshold
  );
  if (crossed.length === 0) return null;

  const threshold = Math.max(...crossed);
  if (!shouldSend(`budget:${threshold}`)) return threshold;

  post(
    threshold >= 100
      ? `🛑 *Chat daily budget reached* — ${currentCount}/${budget} requests used today. ` +
          "Further chat requests are being answered with the contact-support message and are NOT calling Gemini."
      : `📈 *Chat daily budget at ${threshold}%* — ${currentCount}/${budget} requests used today.`
  );
  return threshold;
}

// SEG §11: "Error and 429 rate above a baseline — the earliest sign of a quota
// problem or an outage."
function notifyUpstreamFailure({ status }) {
  if (!shouldSend("upstream_failure")) return;
  post(
    `⚠️ *Chat assistant is failing upstream* (status ${status || "unknown"}). ` +
      "Customers are seeing the fallback message. Check the Gemini key, quota and model ID."
  );
}

// A customer has been handed over and is waiting on a person (SEG F-07). This
// is the one alert that is never throttled: each one is a different customer,
// and collapsing two of them loses one. Volume is already bounded by the rate
// limits in front of the endpoint.
//
// `lastMessage` is the customer's own words, after redaction — card, CVV and ID
// numbers are already stripped upstream. It travels because a colleague picking
// this up needs to know what it is about; the rest of the transcript does not.
function notifyEscalation({ reference, reason, identityType, lastMessage }) {
  post(
    `🙋 *A customer needs a person* — ref *${reference}*\n` +
      `Reason: ${reason || "unspecified"} · ${identityType === "user" ? "signed in" : "guest"}\n` +
      `They said: "${(lastMessage || "").slice(0, 300)}"\n` +
      "They have been given the phone number, email and Support page, and asked to quote this reference."
  );
}

// The kill switch is meant to be flipped at an inconvenient moment — the flip
// itself should be visible to everyone else (SEG §06).
function notifyKillSwitch({ enabled, actor }) {
  post(
    enabled
      ? `🔴 *Chat kill switch ON* — the widget is disabled site-wide (by ${actor || "an admin"}).`
      : `🟢 *Chat kill switch OFF* — the widget is live again (by ${actor || "an admin"}).`
  );
}

module.exports = {
  notifyBudgetUsage,
  notifyUpstreamFailure,
  notifyEscalation,
  notifyKillSwitch,
  BUDGET_THRESHOLDS,
  ALERT_THROTTLE_MS,
};
