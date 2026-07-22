const FRONTEND_URL = process.env.FRONTEND_URL || "";
const LOGO_URL = `${FRONTEND_URL}/staticImages/upcellLogoLight.png`;
const SUPPORT_URL = `${FRONTEND_URL}/support`;
const ACCOUNT_URL = `${FRONTEND_URL}/myaccount`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

const money = (value) => `$${Number(value ?? 0).toFixed(2)}`;

// tone controls the status pill color — success (green) for terminal-positive
// states, progress (brand red tint) for everything still in motion.
const PILL_TONES = {
  progress: { bg: "rgba(217,11,15,0.14)", text: "#FF6B6E", border: "rgba(217,11,15,0.35)" },
  success: { bg: "rgba(52,199,89,0.14)", text: "#4CD873", border: "rgba(52,199,89,0.35)" },
  neutral: { bg: "rgba(255,255,255,0.08)", text: "#B4B4BA", border: "rgba(255,255,255,0.16)" },
};

/**
 * Shared table-based shell — dark card floating on a light page background,
 * built for Gmail/Outlook/Apple Mail rather than modern CSS (no flex/grid,
 * inline styles on every element, real <table> layout throughout).
 */
function emailShell({ preheader, badgeGlyph = "✓", headline, pill, bodyHtml, extraRowsHtml = "", ctaLabel, ctaHref }) {
  const tone = PILL_TONES[pill?.tone] || PILL_TONES.neutral;
  const font = "'Roboto',Helvetica,Arial,sans-serif";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>UpCell</title>
<style>
  body,table,td,a{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img{ -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
  body{ margin:0; padding:0; width:100% !important; background-color:#EDEDED; }
  a[x-apple-data-detectors]{ color:inherit !important; text-decoration:none !important; }
  @media screen and (max-width:600px){
    .email-container{ width:100% !important; border-radius:0 !important; }
    .email-pad{ padding-left:24px !important; padding-right:24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#EDEDED;">
  <span style="display:none;font-size:1px;color:#EDEDED;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader || "")}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EDEDED;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#141416;border:1px solid #2A2A2E;border-radius:16px;overflow:hidden;">

        <tr><td align="center" class="email-pad" bgcolor="#0E0E10" style="background-color:#0E0E10;padding:28px 40px 20px;border-bottom:1px solid #2A2A2E;">
          <img src="${LOGO_URL}" width="120" alt="UpCell" style="display:block;border:0;" />
        </td></tr>

        <tr><td align="center" style="padding:24px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:44px;height:44px;border-radius:50%;background-color:${tone.bg};border:1px solid ${tone.border};text-align:center;vertical-align:middle;font-family:${font};font-size:19px;line-height:44px;color:${tone.text};">${badgeGlyph}</td>
          </tr></table>
        </td></tr>

        <tr><td align="center" class="email-pad" style="padding:18px 40px 0;">
          <h1 style="margin:0;font-family:${font};font-size:21px;line-height:1.3;font-weight:700;color:#FFFFFF;">${headline}</h1>
        </td></tr>

        ${pill ? `<tr><td align="center" style="padding:10px 40px 0;">
          <span style="display:inline-block;padding:4px 14px;border-radius:100px;font-family:${font};font-size:11.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;background-color:${tone.bg};color:${tone.text};border:1px solid ${tone.border};">${escapeHtml(pill.label)}</span>
        </td></tr>` : ""}

        <tr><td align="center" class="email-pad" style="padding:18px 40px 4px;">
          <p style="margin:0;font-family:${font};font-size:14.5px;line-height:1.65;color:#B4B4BA;">${bodyHtml}</p>
        </td></tr>

        ${extraRowsHtml}

        ${ctaHref ? `<tr><td align="center" class="email-pad" style="padding:26px 40px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:100px;background-color:#D90B0F;">
            <a href="${ctaHref}" style="display:inline-block;padding:14px 34px;font-family:${font};font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:100px;">${escapeHtml(ctaLabel)}</a>
          </td></tr></table>
        </td></tr>` : `<tr><td style="padding:0 0 24px;">&nbsp;</td></tr>`}

        <tr><td class="email-pad" style="padding:0 40px;">
          <div style="height:1px;background-color:#232326;line-height:1px;font-size:1px;">&nbsp;</div>
        </td></tr>

        <tr><td align="center" class="email-pad" style="padding:20px 40px 32px;">
          <p style="margin:0;font-family:${font};font-size:11.5px;line-height:1.6;color:#77777D;">
            Certified pre-owned Apple devices, backed by UpCell.<br />
            Questions? Reply to this email or visit our <a href="${SUPPORT_URL}" style="color:#9A9AA0;">support page</a>.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function tradeInRequestEmail({ name, modelTitle, estimate, requestId }) {
  return {
    subject: `Your UpCell trade-in request — ${modelTitle} (#${String(requestId).slice(-6)})`,
    html: emailShell({
      preheader: `We received your ${modelTitle} trade-in — estimated payout ${money(estimate)}.`,
      badgeGlyph: "✓",
      headline: `Request received, ${escapeHtml(name)}!`,
      pill: { label: "New", tone: "progress" },
      bodyHtml: `We received your trade-in request for <strong style="color:#FFFFFF;">${escapeHtml(modelTitle)}</strong> (Request ID: ${escapeHtml(requestId)}). Estimated payout: <strong style="color:#FFFFFF;">${money(estimate)}</strong>. We'll email your prepaid shipping label and next steps within 1 business day.`,
      ctaLabel: "Contact Support",
      ctaHref: SUPPORT_URL,
    }),
  };
}

const TRADE_IN_STATUS_COPY = {
  New: { pillTone: "progress", body: "We've logged your request and will review it shortly." },
  Contacted: { pillTone: "progress", body: "Our team has reviewed your trade-in request and will be in touch shortly with next steps." },
  Received: { pillTone: "progress", body: "Your device has arrived and is now being inspected." },
  Quoted: { pillTone: "progress", body: "Your final trade-in offer is ready — see the amount above." },
  Paid: { pillTone: "success", body: "Payment for your trade-in has been sent. Thanks for trading in with UpCell." },
};

function tradeInStatusEmail({ name, status, estimate, requestId }) {
  const copy = TRADE_IN_STATUS_COPY[status] || TRADE_IN_STATUS_COPY.Contacted;
  const amountLine = status === "Quoted" || status === "Paid"
    ? ` Amount: <strong style="color:#FFFFFF;">${money(estimate)}</strong>.`
    : "";

  return {
    subject: `Your UpCell trade-in request — update (#${String(requestId).slice(-6)})`,
    html: emailShell({
      preheader: `Your trade-in status is now ${status}.`,
      badgeGlyph: status === "Paid" ? "✓" : "↻",
      headline: `Your trade-in status: <span style="color:#FF6B6E;">${escapeHtml(status)}</span>`,
      pill: { label: status, tone: copy.pillTone },
      bodyHtml: `Hi ${escapeHtml(name)}, ${copy.body}${amountLine} (Request ID: ${escapeHtml(requestId)})`,
      ctaLabel: "Contact Support",
      ctaHref: SUPPORT_URL,
    }),
  };
}

const ORDER_STATUS_COPY = {
  Processing: { pillTone: "progress", body: "we're getting your order ready." },
  Shipped: { pillTone: "progress", body: "your order is on its way." },
  Delivered: { pillTone: "success", body: "your order has been delivered." },
  Returned: { pillTone: "neutral", body: "your return has been received." },
  Refunded: { pillTone: "neutral", body: "your refund has been processed." },
  "payment failed": { pillTone: "progress", body: "we couldn't confirm payment for this order yet." },
};

function orderStatusEmail({ orderId, status }) {
  const copy = ORDER_STATUS_COPY[status] || { pillTone: "neutral", body: "your order status has changed." };

  return {
    subject: `Order status changed to ${status}`,
    html: emailShell({
      preheader: `Order ${orderId} is now ${status}.`,
      badgeGlyph: status === "Delivered" ? "✓" : "□",
      headline: `Your order status: <span style="color:#FF6B6E;">${escapeHtml(status)}</span>`,
      pill: { label: status, tone: copy.pillTone },
      bodyHtml: `Hi there, ${copy.body} Order ID: <strong style="color:#FFFFFF;">${escapeHtml(orderId)}</strong>. Thank you for staying with UpCell.`,
      ctaLabel: "View My Orders",
      ctaHref: ACCOUNT_URL,
    }),
  };
}

function lineItemsTable(lineItems, total) {
  const font = "'Roboto',Helvetica,Arial,sans-serif";
  const rows = lineItems.map((item, index) => {
    const rowBg = index % 2 === 0 ? "#1A1A1D" : "#161618";
    return `
    <tr>
      <td bgcolor="${rowBg}" style="background-color:${rowBg};padding:11px 14px;font-family:${font};font-size:13px;color:#E4E4E7;border-top:1px solid #262629;">${escapeHtml(item.name)}</td>
      <td bgcolor="${rowBg}" align="center" style="background-color:${rowBg};padding:11px 14px;font-family:${font};font-size:13px;color:#B4B4BA;border-top:1px solid #262629;">${escapeHtml(item.qty)}</td>
      <td bgcolor="${rowBg}" align="right" style="background-color:${rowBg};padding:11px 14px;font-family:${font};font-size:13px;color:#E4E4E7;border-top:1px solid #262629;">${money(item.price)}</td>
    </tr>`;
  }).join("");

  return `<tr><td class="email-pad" style="padding:10px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #2A2A2E;border-radius:10px;">
      <tr>
        <td bgcolor="#202023" style="background-color:#202023;padding:10px 14px;font-family:${font};font-size:10.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#83838A;border-top-left-radius:9px;">Item</td>
        <td bgcolor="#202023" align="center" style="background-color:#202023;padding:10px 14px;font-family:${font};font-size:10.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#83838A;">Qty</td>
        <td bgcolor="#202023" align="right" style="background-color:#202023;padding:10px 14px;font-family:${font};font-size:10.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#83838A;border-top-right-radius:9px;">Price</td>
      </tr>
      ${rows}
      <tr>
        <td bgcolor="#202023" colspan="2" style="background-color:#202023;padding:13px 14px;font-family:${font};font-size:13.5px;font-weight:700;color:#FFFFFF;border-top:1px solid #2A2A2E;border-bottom-left-radius:9px;">Total</td>
        <td bgcolor="#202023" align="right" style="background-color:#202023;padding:13px 14px;font-family:${font};font-size:13.5px;font-weight:700;color:#FFFFFF;border-top:1px solid #2A2A2E;border-bottom-right-radius:9px;">${money(total)}</td>
      </tr>
    </table>
  </td></tr>`;
}

function paymentReceiptEmail({ orderId, paidWith, lineItems, total }) {
  return {
    subject: "Payment received — thank you!",
    html: emailShell({
      preheader: `We've received your payment of ${money(total)}. Order ${orderId}.`,
      badgeGlyph: "✓",
      headline: "Payment received — thank you!",
      pill: { label: "Paid", tone: "success" },
      bodyHtml: `Your payment via <strong style="color:#FFFFFF;">${escapeHtml(paidWith)}</strong> was successful. Order ID: <strong style="color:#FFFFFF;">${escapeHtml(orderId)}</strong>.`,
      extraRowsHtml: lineItemsTable(lineItems, total),
      ctaLabel: "View Order Details",
      ctaHref: ACCOUNT_URL,
    }),
  };
}

module.exports = {
  emailShell,
  tradeInRequestEmail,
  tradeInStatusEmail,
  orderStatusEmail,
  paymentReceiptEmail,
};
