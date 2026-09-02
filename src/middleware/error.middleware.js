const { Resend } = require("resend");
const { adminErrorAlertEmail } = require("../services/emailTemplates");
const { EmailConfig } = require("../models/emailConfig.model");
const { postToGoogleChat } = require("../services/alertService");

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const alertEmailFrom = process.env.EMAIL_FROM;

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
  // Posting is shared with the payment checks via alertService — the same
  // webhook, the same "a 4xx resolves rather than rejects" trap to handle.
  // Only the wording differs, and it stays here: this alert is deliberately
  // vague because it fires for any 5xx, where naming a cause would be a guess.
  //
  // Plain text with Chat's own lightweight markup (*bold*) — every webhook
  // supports this with no schema to get wrong, unlike cardsV2 which needs an
  // exact nested structure and fails silently if it's off.
  postToGoogleChat(
    "🔧 *A little hiccup on the site*\n" +
      "Nothing urgent — something needs a developer's attention. They've already been notified and will take a look soon."
  );
}

async function sendErrorAlert() {
  const now = Date.now();
  if (now - lastAlertSentAt < ALERT_THROTTLE_MS) return;

  // Admin-controlled mute (Admin > Email Settings) — lets a developer turn
  // off both the alert email and the Google Chat ping while intentionally
  // testing something expected to 5xx, without touching code or .env.
  const config = await EmailConfig.findOne().catch(() => null);
  if (config && config.enableErrorAlerts === false) return;

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
