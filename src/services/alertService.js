const { sendMail } = require("./mailService");
const { adminPaymentAlertEmail } = require("./emailTemplates");
const { EmailConfig } = require("../models/emailConfig.model");

const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const alertEmailFrom = process.env.EMAIL_FROM;
const googleChatWebhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

// The error middleware already sent alerts to Google Chat and email, but kept
// both functions private — so the reconciliation check had no way to reach the
// channels the team actually watches. This is the same two channels, extracted
// so anything that finds a problem can raise it the same way.

// One throttle bucket per alert kind. A shared timer would let a burst of 500s
// silence a payment alert, which is the one that must always get through.
const THROTTLE_MS = 15 * 60 * 1000;
const lastSentByKind = new Map();

const throttled = (kind) => {
  const now = Date.now();
  const last = lastSentByKind.get(kind) || 0;
  if (now - last < THROTTLE_MS) return true;
  lastSentByKind.set(kind, now);
  return false;
};

// Same admin switch that mutes the error alerts, so one control turns off all
// outbound noise while someone is deliberately testing.
const alertsEnabled = async () => {
  try {
    const config = await EmailConfig.findOne().lean();
    return config ? config.enableErrorAlerts !== false : true;
  } catch (error) {
    // A database problem is exactly when an alert matters most — send anyway.
    return true;
  }
};

async function postToGoogleChat(text) {
  if (!googleChatWebhookUrl) return { sent: false, reason: "no_webhook_url" };

  try {
    const response = await fetch(googleChatWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    // fetch() only rejects on a network failure — a 4xx from Google Chat
    // (revoked webhook, bad payload) resolves normally and would otherwise
    // fail silently.
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[alert] Google Chat rejected (${response.status}):`, body);
      return { sent: false, reason: `http_${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.error("[alert] Google Chat post failed:", error?.message || error);
    return { sent: false, reason: "network_error" };
  }
}

/**
 * Raise an operational alert on both channels the team watches.
 *
 * @param {string} kind      throttle bucket, e.g. "payment_reconciliation"
 * @param {string} title     one line, shows as the Chat heading and mail subject
 * @param {string} summary   one sentence of plain English
 * @param {string[]} lines   the specifics, one finding per line
 * @param {boolean} urgent   skips the throttle — money is involved
 */
async function sendOpsAlert({ kind, title, summary, lines = [], urgent = false }) {
  if (!urgent && throttled(kind)) return { skipped: "throttled" };
  if (!(await alertsEnabled())) return { skipped: "alerts_disabled" };

  const chatText =
    `${urgent ? "🚨" : "🔔"} *${title}*\n${summary}` +
    (lines.length ? "\n\n" + lines.map((l) => `• ${l}`).join("\n") : "");

  const chat = await postToGoogleChat(chatText);

  let mail = { sent: false, reason: "not_configured" };
  if (adminNotificationEmail && alertEmailFrom) {
    const { subject, html } = adminPaymentAlertEmail({ title, summary, lines, urgent });
    mail = await sendMail({
      from: alertEmailFrom,
      to: adminNotificationEmail,
      subject,
      html,
    });
  }

  return { chat, mail };
}

module.exports = { sendOpsAlert, postToGoogleChat };
