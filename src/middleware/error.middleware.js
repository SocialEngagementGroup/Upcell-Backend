const { Resend } = require("resend");
const { adminErrorAlertEmail } = require("../services/emailTemplates");

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const alertEmailFrom = process.env.EMAIL_FROM;
const googleChatWebhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

// Simple in-memory throttle so a burst of 500s (e.g. DB outage) sends one
// alert instead of flooding the admin inbox/chat.
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
let lastAlertSentAt = 0;

function sendEmailAlert() {
  if (!adminNotificationEmail || !alertEmailFrom) return;

  const { subject, html } = adminErrorAlertEmail();

  resend.emails
    .send({ from: alertEmailFrom, to: [adminNotificationEmail], subject, html })
    .catch((emailErr) => {
      console.error("Failed to send error alert email:", emailErr);
    });
}

function sendGoogleChatAlert() {
  if (!googleChatWebhookUrl) return;

  // Plain text with Chat's own lightweight markup (*bold*) — every webhook
  // supports this with no schema to get wrong, unlike cardsV2 which needs an
  // exact nested structure and fails silently if it's off.
  const payload = {
    text:
      "🔧 *A little hiccup on the site*\n" +
      "Nothing urgent — something needs a developer's attention. They've already been notified and will take a look soon.",
  };

  fetch(googleChatWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      // fetch() only rejects on network failure — a 4xx/5xx from Google
      // Chat (bad payload, revoked webhook, etc.) resolves normally and
      // would otherwise fail silently.
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`Google Chat alert rejected (${response.status}):`, body);
      }
    })
    .catch((chatErr) => {
      console.error("Failed to send Google Chat alert:", chatErr);
    });
}

function sendErrorAlert() {
  const now = Date.now();
  if (now - lastAlertSentAt < ALERT_THROTTLE_MS) return;
  lastAlertSentAt = now;

  sendEmailAlert();
  sendGoogleChatAlert();
}

function errorHandler(err, req, res, next) {
  console.error("Global Error Handler:", err);
  const status = err.status || 500;

  if (status >= 500) {
    sendErrorAlert();
  }

  // 5xx means something unexpected broke (DB error, third-party API
  // failure, a bug) — err.message can contain internal details (stack
  // context, library internals) that shouldn't reach the client. The real
  // message still goes to the console log and the admin alert email above;
  // only the client-facing response is genericized. 4xx errors are
  // deliberately client-facing (e.g. explicit res.status(4xx) calls
  // elsewhere), so this branch never touches those.
  res.status(status).json({
    error: status >= 500 ? "Internal Server Error" : err.message || "Internal Server Error",
    details: status >= 500 ? null : err.details || null,
  });
}

module.exports = { errorHandler };
