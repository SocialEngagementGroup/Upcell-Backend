const FRONTEND_URL = process.env.FRONTEND_URL || "";
// Dark-on-transparent mark on a light logo panel — see emailShell below.
const LOGO_URL = `${FRONTEND_URL}/staticImages/upcellLogo.png`;
const SUPPORT_URL = `${FRONTEND_URL}/support`;
const ACCOUNT_URL = `${FRONTEND_URL}/myaccount`;

const FONT = "'Roboto',Helvetica,Arial,sans-serif";
const RED = "#D90B0F";

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

// One <tr> in the dark detail-rows box — label on the left, value on the
// right, with a divider under every row except the last (bordered=false).
function detailRow(label, value, { bordered = true, valueColor = "#FFFFFF", valueWeight = 600 } = {}) {
  const border = bordered ? "border-bottom:1px solid #2E2E2E;" : "";
  return `<tr>
    <td style="padding:9px 0;${border}font-family:${FONT};font-size:14px;color:#9A9A9A;">${label}</td>
    <td align="right" style="padding:9px 0;${border}font-family:${FONT};font-weight:${valueWeight};font-size:14px;color:${valueColor};">${value}</td>
  </tr>`;
}

// The dark #1B1B1B rounded box that wraps a set of detailRow()s.
function detailRowsBox(rowsHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1B1B1B;border-radius:16px;">
    <tr><td style="padding:18px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
    </td></tr>
  </table>`;
}

/**
 * Shared shell for every transactional email: a light logo panel sitting
 * directly on top of a dark body card (two separately-rounded boxes, not
 * one), a solid-red icon badge, headline, subtext, a dark detail-rows box,
 * and a full-width CTA pill. Table-based layout throughout — built for
 * Gmail/Outlook/Apple Mail, not modern CSS (no flex/grid, inline styles on
 * every element).
 */
function emailShell({ preheader, badgeGlyph = "&#10003;", headline, subtext, detailRowsHtml, ctaLabel, ctaHref, footerNote }) {
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
  @media screen and (max-width:520px){
    .email-wrapper, .logo-panel, .card{ width:100% !important; max-width:100% !important; }
    .card-pad{ padding-left:24px !important; padding-right:24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#EDEDED;">
  <span style="display:none;font-size:1px;color:#EDEDED;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader || "")}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EDEDED;">
    <tr><td align="center" style="padding:40px 16px;">

      <table role="presentation" class="email-wrapper" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

        <!-- Logo panel -->
        <tr><td align="center">
          <table role="presentation" class="logo-panel" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:480px;background-color:#F7F7F7;border-radius:24px 24px 0 0;">
            <tr><td align="center" valign="middle" style="height:109px;">
              <img src="${LOGO_URL}" width="220" alt="UpCell" style="display:block;border:0;max-width:70%;" />
            </td></tr>
          </table>
        </td></tr>

        <!-- Body card -->
        <tr><td align="center">
          <table role="presentation" class="card" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:480px;background-color:#0C0C0C;border-radius:0 0 24px 24px;box-shadow:0 8px 28px rgba(20,20,20,0.10);">
            <tr><td class="card-pad" style="padding:44px 40px 40px 40px;">

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center" style="padding-bottom:24px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:64px;height:64px;">
                    <tr><td align="center" valign="middle" bgcolor="${RED}" style="width:64px;height:64px;border-radius:32px;background-color:${RED};box-shadow:0 6px 16px rgba(217,11,15,0.35);font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:64px;color:#FFFFFF;font-weight:bold;">${badgeGlyph}</td></tr>
                  </table>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center" style="font-family:${FONT};font-weight:bold;font-size:24px;line-height:30px;color:#FFFFFF;padding:0 8px;">${headline}</td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center" style="font-family:${FONT};font-weight:normal;font-size:14px;line-height:21px;color:#A6A6A6;padding:10px 6px 28px 6px;">${subtext}</td></tr>
              </table>

              ${detailRowsHtml ? detailRowsBox(detailRowsHtml) : ""}

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr><td align="center" bgcolor="${RED}" style="border-radius:999px;">
                  <a href="${ctaHref}" target="_blank" style="display:block;padding:16px 24px;font-family:${FONT};font-weight:bold;font-size:15px;color:#FFFFFF;text-decoration:none;border-radius:999px;">${escapeHtml(ctaLabel)}</a>
                </td></tr>
              </table>

            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:28px 16px 0 16px;font-family:${FONT};font-size:12px;line-height:18px;color:#9A9A9A;">
          UpCell Inc. &mdash; 973 Harrisburg Pike, Columbus, OH, United States, Ohio<br />
          ${footerNote}
          <a href="${SUPPORT_URL}" style="color:#9A9AA0;text-decoration:underline;">Unsubscribe</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function tradeInRequestEmail({ name, modelTitle, estimate, requestId }) {
  const rows =
    detailRow("Device", escapeHtml(modelTitle)) +
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Estimated Value", money(estimate)) +
    detailRow("Status", "New", { bordered: false, valueColor: RED, valueWeight: 700 });

  return {
    subject: `Your UpCell trade-in request — ${modelTitle} (#${String(requestId).slice(-6)})`,
    html: emailShell({
      preheader: `We received your ${modelTitle} trade-in — estimated payout ${money(estimate)}.`,
      badgeGlyph: "&#10003;",
      headline: `Request received, ${escapeHtml(name)}!`,
      subtext: "We&rsquo;ve got your trade-in details. Our team will review your device and follow up shortly.",
      detailRowsHtml: rows,
      ctaLabel: "Track Your Trade-In",
      ctaHref: SUPPORT_URL,
      footerNote: "You're receiving this because you submitted a trade-in request.",
    }),
  };
}

const TRADE_IN_STATUS_COPY = {
  New: { body: "We've logged your request and will review it shortly." },
  Contacted: { body: "Our team has reviewed your trade-in request and will be in touch shortly with next steps." },
  Received: { body: "Your device has arrived and is now being inspected." },
  Quoted: { body: "Your final trade-in offer is ready — see the amount below." },
  Paid: { body: "Payment for your trade-in has been sent. Thanks for trading in with UpCell." },
};

function tradeInStatusEmail({ name, modelTitle, status, estimate, requestId }) {
  const copy = TRADE_IN_STATUS_COPY[status] || TRADE_IN_STATUS_COPY.Contacted;
  const rows =
    detailRow("Device", modelTitle ? escapeHtml(modelTitle) : "&mdash;") +
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Estimated Value", money(estimate)) +
    detailRow("Status", escapeHtml(status), { bordered: false, valueColor: RED, valueWeight: 700 });

  return {
    subject: `Your UpCell trade-in request — update (#${String(requestId).slice(-6)})`,
    html: emailShell({
      preheader: `Your trade-in status is now ${status}.`,
      badgeGlyph: status === "Paid" ? "&#10003;" : "&#128260;",
      headline: `Your trade-in status: <span style="color:${RED};">${escapeHtml(status)}</span>`,
      subtext: `Hi ${escapeHtml(name)}, ${copy.body}`,
      detailRowsHtml: rows,
      ctaLabel: "Track Your Trade-In",
      ctaHref: SUPPORT_URL,
      footerNote: "You're receiving this because you submitted a trade-in request.",
    }),
  };
}

const ORDER_STATUS_BADGE = {
  Delivered: "&#10003;",
  Shipped: "&#128230;",
  Processing: "&#128260;",
};

function orderStatusEmail({ orderId, status }) {
  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Status", escapeHtml(status), { bordered: false, valueColor: RED, valueWeight: 700 });

  return {
    subject: `Order status changed to ${status}`,
    html: emailShell({
      preheader: `Order ${orderId} is now ${status}.`,
      badgeGlyph: ORDER_STATUS_BADGE[status] || "&#128230;",
      headline: `Your order status: <span style="color:${RED};">${escapeHtml(status)}</span>`,
      subtext: "We&rsquo;ll let you know as soon as there&rsquo;s another update.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
    }),
  };
}

function paymentReceiptEmail({ orderId, paidWith, lineItems, total }) {
  const itemRows = (lineItems || [])
    .map(
      (item) =>
        `<tr>
          <td style="padding:6px 0;font-family:${FONT};font-size:13px;color:#C7C7C7;">${escapeHtml(item.name)} &times;${escapeHtml(item.qty)}</td>
          <td align="right" style="padding:6px 0;font-family:${FONT};font-weight:500;font-size:13px;color:#E4E4E4;">${money(item.price)}</td>
        </tr>`
    )
    .join("");

  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Items</td></tr>` +
    itemRows +
    detailRow("Paid With", escapeHtml(paidWith)) +
    detailRow("Total", money(total), { bordered: false, valueColor: "#FFFFFF", valueWeight: 800 });

  return {
    subject: "Payment received — thank you!",
    html: emailShell({
      preheader: `We've received your payment of ${money(total)}. Order ${orderId}.`,
      badgeGlyph: "&#10003;",
      headline: "Payment received &mdash; thank you!",
      subtext: `Here&rsquo;s your receipt for order #${escapeHtml(orderId)}.`,
      detailRowsHtml: rows,
      ctaLabel: "View Order Details",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
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
