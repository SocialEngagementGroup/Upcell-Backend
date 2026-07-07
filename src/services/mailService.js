const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_KEY);

async function sendMail({ from, to, subject, html, headers }) {
  try {
    const response = await resend.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(headers ? { headers } : {}),
    });
    return { sent: true, id: response?.data?.id || null };
  } catch (error) {
    console.error("[mailService] send failed:", error?.message || error);
    return { sent: false, error: error?.message || "Unknown error" };
  }
}

// Resend ignores a custom "Message-ID" header and always assigns its own
// (via the underlying AWS SES infra) — so the real Message-ID has to be
// looked up after sending before it can be referenced by a later reply.
async function getMessageId(id) {
  try {
    const response = await resend.emails.get(id);
    return response?.data?.message_id || null;
  } catch (error) {
    console.error("[mailService] fetch message id failed:", error?.message || error);
    return null;
  }
}

module.exports = { sendMail, getMessageId };
