const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const alertEmailFrom = process.env.EMAIL_FROM;

// Simple in-memory throttle so a burst of 500s (e.g. DB outage) sends one
// alert instead of flooding the admin inbox.
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
let lastAlertSentAt = 0;

function sendErrorAlert(err, req) {
  if (!adminNotificationEmail || !alertEmailFrom) return;

  const now = Date.now();
  if (now - lastAlertSentAt < ALERT_THROTTLE_MS) return;
  lastAlertSentAt = now;

  resend.emails
    .send({
      from: alertEmailFrom,
      to: [adminNotificationEmail],
      subject: `[Upcell] Server error: ${req.method} ${req.originalUrl}`,
      html: `<p><strong>${err.message || "Internal Server Error"}</strong></p><p>${req.method} ${req.originalUrl}</p><pre>${(err.stack || "").slice(0, 2000)}</pre>`,
    })
    .catch((emailErr) => {
      console.error("Failed to send error alert email:", emailErr);
    });
}

function errorHandler(err, req, res, next) {
  console.error("Global Error Handler:", err);
  const status = err.status || 500;

  if (status >= 500) {
    sendErrorAlert(err, req);
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
