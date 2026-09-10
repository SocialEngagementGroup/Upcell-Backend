const FRONTEND_URL = process.env.FRONTEND_URL || "";
// Dark-on-transparent mark on a light logo panel — see emailShell below.
const LOGO_URL = `${FRONTEND_URL}/staticImages/upcellLogo.png`;
const SUPPORT_URL = `${FRONTEND_URL}/support`;
const ACCOUNT_URL = `${FRONTEND_URL}/myaccount`;
const ADMIN_ORDERS_URL = `${FRONTEND_URL}/admin-secret/orders`;
const adminTradeInUrl = (requestId) => `${FRONTEND_URL}/admin-secret/trade-in/${requestId}`;

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

function orderPlacedEmail({ orderId, name }) {
  const rows = detailRow("Order ID", `#${escapeHtml(orderId)}`, {
    bordered: false,
    valueColor: RED,
    valueWeight: 700,
  });

  return {
    subject: "Your order has been placed",
    html: emailShell({
      preheader: `We've received your order #${orderId}. We'll be in touch shortly.`,
      badgeGlyph: "&#10003;",
      headline: `Thanks${name ? `, ${escapeHtml(name)}` : ""}! Your order has been placed.`,
      subtext: "We&rsquo;ve received your order and our team will follow up shortly with next steps.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
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

function paymentReceiptEmail({ orderId, paidWith, lineItems, total, orderUrl }) {
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
      // A guest has no account page to send them to, so the receipt carries
      // the only link they will ever have to this order. Signed-in customers
      // keep going to their own order list.
      ctaLabel: orderUrl ? "View Your Order" : "View Order Details",
      ctaHref: orderUrl || ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
    }),
  };
}

// itemNames is a plain list of what was refunded ("iPhone 17 (Sage, 256GB)"),
// not the raw line_items — the email should read like a person wrote it, not
// like a database dump.
function refundApprovedEmail({ orderId, itemNames, itemsTotal, restockingFee, taxRefunded, refundAmount }) {
  const itemRows = (itemNames || [])
    .map(
      (name) =>
        `<tr><td colspan="2" style="padding:5px 0;font-family:${FONT};font-size:13px;color:#C7C7C7;">${escapeHtml(name)}</td></tr>`
    )
    .join("");

  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Items refunded</td></tr>` +
    itemRows +
    detailRow("Items total", money(itemsTotal)) +
    (restockingFee > 0
      // Only shown if an old refund still carries one. Nothing charges it now.
      ? detailRow("Restocking fee", `&minus;${money(restockingFee)}`)
      : "") +
    // Shown as its own line rather than folded into the total: a customer
    // checking the figure against their card statement is adding up the same
    // rows UpCell did, and the tax is the row they are most likely to query.
    (taxRefunded > 0 ? detailRow("Sales tax refunded", money(taxRefunded)) : "") +
    detailRow("Refund amount", money(refundAmount), { bordered: false, valueColor: "#FFFFFF", valueWeight: 800 });

  return {
    subject: "Your refund has been approved",
    html: emailShell({
      preheader: `${money(refundAmount)} has been approved for order ${orderId}.`,
      badgeGlyph: "&#8617;",
      headline: "Refund approved",
      // Accurate without exposing the internal process: nothing here claims
      // the bank has been contacted automatically, because it has not — a
      // person still enters this by hand. "Being processed" is true the
      // moment this email sends and stays true until they do.
      subtext: "Your refund has been approved and is being processed. It typically takes 2 business days to reach your original payment method.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
    }),
  };
}

// ---------------------------------------------------------------------------
// The refund request journey.
//
// Six emails, one per stage a customer would otherwise have to chase by phone.
// The rule running through them: never claim more than has happened. A device
// nobody has looked at yet is "received", not "approved"; money a person still
// has to enter at the bank is "on its way", not "paid".
// ---------------------------------------------------------------------------

const itemNameRows = (itemNames = []) =>
  itemNames
    .map(
      (name) =>
        `<tr><td colspan="2" style="padding:5px 0;font-family:${FONT};font-size:13px;color:#C7C7C7;">${escapeHtml(name)}</td></tr>`
    )
    .join("");

// Long free text written by staff — return addresses, packing notes. Newlines
// are what they typed, so they have to survive into the HTML or the whole
// thing arrives as one run-on paragraph.
const paragraphs = (text) =>
  String(text || "")
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<tr><td colspan="2" style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:22px;color:#C7C7C7;">${escapeHtml(block).replace(/\n/g, "<br />")}</td></tr>`
    )
    .join("");

function refundRequestReceivedEmail({ requestId, orderId, itemNames }) {
  const rows =
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Items you want to return</td></tr>` +
    itemNameRows(itemNames);

  return {
    subject: "We've received your return request",
    html: emailShell({
      preheader: `Your return request for order ${orderId} has been received.`,
      badgeGlyph: "&#8617;",
      headline: "Return request received",
      // Says plainly that nothing has been agreed yet. A customer who reads
      // this as approval will post a phone before being told where to send it.
      //
      // No fee and no postage warning: returns are free in both directions,
      // whatever the reason. This used to promise 15% to everyone.
      subtext:
        "Thanks — we have your request and will review it shortly. Please don't send anything back yet: we'll email you a prepaid label and the return address once it's approved. Returns are free, and the sales tax you paid comes back with the refund.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you asked to return an item.",
    }),
  };
}

// Everything the customer needs to actually post the parcel: the number to
// write on it, the label to print, the carrier, and the date the authorisation
// runs out. Sent when staff attach the label, which is the first moment all of
// those exist together.
function returnLabelIssuedEmail({ rmaNumber, orderId, carrier, trackingNumber, labelUrl, expiresAt, itemNames }) {
  const rows =
    detailRow("Return number", escapeHtml(rmaNumber)) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Carrier", escapeHtml(carrier)) +
    detailRow("Tracking number", escapeHtml(trackingNumber)) +
    (expiresAt ? detailRow("Post it by", escapeHtml(new Date(expiresAt).toDateString())) : "") +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Items to return</td></tr>` +
    itemNameRows(itemNames);

  return {
    subject: `Your return label — ${rmaNumber}`,
    html: emailShell({
      preheader: `Print your label and post ${rmaNumber} back to us.`,
      badgeGlyph: "&#128230;",
      headline: "Your return label is ready",
      // The deadline is stated in the body as well as the rows, because it is
      // the one thing that costs the customer their return if they miss it.
      subtext:
        `Print the label, write ${escapeHtml(rmaNumber)} on the outside of the box, and drop it off with ${escapeHtml(carrier)}. `
        + (expiresAt
          ? `Please post it by ${escapeHtml(new Date(expiresAt).toDateString())} — after that the authorisation expires and you'll need to request the return again.`
          : "Please post it as soon as you can."),
      detailRowsHtml: rows,
      // Straight to the label, because that is the thing they need to do next.
      ctaLabel: labelUrl ? "Print Your Label" : "View Your Return",
      ctaHref: labelUrl || ACCOUNT_URL,
      footerNote: "You're receiving this because you asked to return an item.",
    }),
  };
}

// The one email a customer actually waits for.
//
// Tracking number in the rows and the carrier's own page behind the button:
// "where is my order" is the question support answers most, and it is answered
// here or it is answered by a person.
function orderShippedEmail({ orderId, carrier, trackingNumber, trackingUrl, itemNames }) {
  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Carrier", escapeHtml(carrier)) +
    detailRow("Tracking number", escapeHtml(trackingNumber)) +
    (itemNames && itemNames.length
      ? `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">On its way</td></tr>`
        + itemNameRows(itemNames)
      : "");

  return {
    subject: `Your UpCell order has shipped — ${trackingNumber}`,
    html: emailShell({
      preheader: `${carrier} has your order. Track it with ${trackingNumber}.`,
      badgeGlyph: "&#128666;",
      headline: "Your order is on its way",
      subtext:
        `${escapeHtml(carrier)} has your parcel. Tracking can take a few hours to show its first scan, `
        + "so don't worry if it looks quiet at first.",
      detailRowsHtml: rows,
      ctaLabel: trackingUrl ? "Track Your Order" : "View Your Order",
      ctaHref: trackingUrl || ACCOUNT_URL,
      footerNote: "You're receiving this because you placed an order with UpCell.",
    }),
  };
}

// A fresh link to a guest's own order, because they asked for one.
//
// Sent only to the address already on the order. The form asks for it so the
// customer proves they know it; it is never used as a delivery address, or
// this endpoint would be a way to post somebody's order details anywhere.
function orderLinkEmail({ orderId, orderUrl }) {
  return {
    subject: "Your UpCell order link",
    html: emailShell({
      preheader: "Here is the link to your order.",
      badgeGlyph: "&#128279;",
      headline: "Here's your order",
      subtext:
        "You asked for a fresh link to your order. Any link we sent you before this one "
        + "has stopped working, so use this one from now on.",
      detailRowsHtml: detailRow("Order ID", `#${escapeHtml(orderId)}`),
      ctaLabel: "View Your Order",
      ctaHref: orderUrl,
      footerNote: "If you didn't ask for this, you can ignore it — nothing has changed.",
    }),
  };
}

// The offer of less than the full refund, and why.
//
// Every deduction is listed with the finding behind it, because a smaller
// number with no explanation is the thing customers dispute and UpCell then
// cannot defend. The two buttons are the whole point: someone reading this on a
// phone should be able to answer without signing in or writing an email.
function revisedOfferEmail({ rmaNumber, originalAmount, offeredAmount, deductions = [], findings, acceptUrl, declineUrl, expiresAt }) {
  const deductionRows = deductions
    .map((deduction) => detailRow(
      escapeHtml(deduction.reason),
      `&minus;$${Number(deduction.amount).toFixed(2)}`
    ))
    .join("");

  const rows =
    detailRow("Return number", escapeHtml(rmaNumber)) +
    detailRow("Original refund", `$${Number(originalAmount).toFixed(2)}`) +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">What we found, and what came off</td></tr>` +
    deductionRows +
    detailRow("Revised refund", `<strong>$${Number(offeredAmount).toFixed(2)}</strong>`) +
    (expiresAt ? detailRow("Please reply by", escapeHtml(new Date(expiresAt).toDateString())) : "");

  return {
    subject: `About your return ${rmaNumber} — revised refund offer`,
    html: emailShell({
      preheader: `We're offering $${Number(offeredAmount).toFixed(2)} for return ${rmaNumber}.`,
      badgeGlyph: "&#9878;",
      headline: "A revised refund offer",
      subtext:
        (findings ? `${escapeHtml(findings)} ` : "")
        + "If you accept, we'll refund the revised amount. If you decline, we'll send the device back to you at our cost — either way you won't be charged anything further."
        + (expiresAt
          ? ` If we don't hear from you by ${escapeHtml(new Date(expiresAt).toDateString())}, we'll send the device back.`
          : ""),
      detailRowsHtml: rows,
      ctaLabel: "Accept This Offer",
      ctaHref: acceptUrl,
      // The decline is a plain link rather than a second button on purpose: it
      // must be equally easy to find, and equally obviously not the default.
      footerNote: declineUrl
        ? `Would rather have the device back? <a href="${declineUrl}" style="color:#D90B0F;">Decline and return it to me</a>.`
        : "You're receiving this because you asked to return an item.",
    }),
  };
}

// A nudge before the authorisation lapses.
//
// The deadline is the whole message. A customer who misses it loses the return
// and has to ask again, which is a support email and an annoyed person over
// something a reminder prevents.
function returnReminderEmail({ rmaNumber, daysLeft, expiresAt, labelUrl, trackingNumber }) {
  const rows =
    detailRow("Return number", escapeHtml(rmaNumber)) +
    detailRow("Post it by", escapeHtml(new Date(expiresAt).toDateString())) +
    (trackingNumber ? detailRow("Tracking number", escapeHtml(trackingNumber)) : "");

  return {
    subject: daysLeft <= 2
      ? `Last chance to post your return ${rmaNumber}`
      : `A reminder about your return ${rmaNumber}`,
    html: emailShell({
      preheader: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left to post return ${rmaNumber}.`,
      badgeGlyph: "&#9200;",
      headline: daysLeft <= 2 ? "Your return expires soon" : "Have you posted it yet?",
      subtext:
        `We haven't received your return yet. You have ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to post it — after ${escapeHtml(new Date(expiresAt).toDateString())} the authorisation expires and you'd need to request the return again.`,
      detailRowsHtml: rows,
      ctaLabel: labelUrl ? "Print Your Label" : "View Your Return",
      ctaHref: labelUrl || ACCOUNT_URL,
      footerNote: "Already posted it? You can ignore this — tracking can take a day to update.",
    }),
  };
}

// The authorisation lapsed. Says how to start again, because the alternative is
// a customer who assumes the door is closed and emails support to ask.
function returnExpiredEmail({ rmaNumber, orderId }) {
  const rows =
    detailRow("Return number", escapeHtml(rmaNumber)) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`);

  return {
    subject: `Your return ${rmaNumber} has expired`,
    html: emailShell({
      preheader: `Return ${rmaNumber} expired because we didn't receive the device.`,
      badgeGlyph: "&#9203;",
      headline: "Your return authorisation has expired",
      subtext:
        "We didn't receive the device within 14 days, so this return number is no longer valid. If you still want to return it, start a new request from your order and we'll issue a fresh one — assuming the item is still inside its return window.",
      detailRowsHtml: rows,
      ctaLabel: "View Your Orders",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you asked to return an item.",
    }),
  };
}

function refundReturnInstructionsEmail({ requestId, orderId, itemNames, instructions }) {
  const rows =
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    `<tr><td colspan="2" style="padding:12px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Items to return</td></tr>` +
    itemNameRows(itemNames) +
    `<tr><td colspan="2" style="padding:16px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">How to return it</td></tr>` +
    paragraphs(instructions);

  return {
    subject: "Return approved — how to send your device back",
    html: emailShell({
      preheader: "Your return has been approved. Here's where to send it.",
      badgeGlyph: "&#8599;",
      headline: "Return approved",
      subtext:
        "Please follow the instructions below to send your device back. Your refund is worked out once it arrives and has been checked.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "Questions about your return? Reply to this email.",
    }),
  };
}

function refundDeviceReceivedEmail({ requestId, orderId }) {
  const rows =
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`);

  return {
    subject: "We've received your device",
    html: emailShell({
      preheader: "Your returned device has arrived with us.",
      badgeGlyph: "&#10003;",
      headline: "Device received",
      // The reassurance email. Its whole job is to stop the customer wondering
      // whether the parcel arrived, which is the point they usually call.
      subtext:
        "Your device has arrived and is waiting to be checked. We'll email you as soon as that's done — usually within a couple of working days.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you returned an item to UpCell.",
    }),
  };
}

function refundRejectedEmail({ requestId, orderId, rejectionReason }) {
  const rows =
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    `<tr><td colspan="2" style="padding:16px 0 4px 0;font-family:${FONT};font-size:14px;color:#9A9A9A;">Reason</td></tr>` +
    paragraphs(rejectionReason);

  return {
    subject: "About your return request",
    html: emailShell({
      preheader: `We couldn't approve the return for order ${orderId}.`,
      badgeGlyph: "&#33;",
      // Neutral subject and headline on purpose. "Refund rejected" in an inbox
      // reads as an accusation before the reason has been read.
      headline: "We couldn't approve this return",
      subtext:
        "We've looked at your request and can't approve it. The reason is below. If you think this is wrong, reply to this email and a person will look again.",
      detailRowsHtml: rows,
      ctaLabel: "Contact Support",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you asked to return an item.",
    }),
  };
}

function refundMoneySentEmail({ requestId, orderId, refundAmount }) {
  const rows =
    detailRow("Request ID", `#${escapeHtml(requestId)}`) +
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Refund amount", money(refundAmount), {
      bordered: false,
      valueColor: "#FFFFFF",
      valueWeight: 800,
    });

  return {
    subject: "Your refund is on its way",
    html: emailShell({
      preheader: `${money(refundAmount)} has been sent back to your card.`,
      badgeGlyph: "&#10003;",
      headline: "Refund sent",
      // The one email that was missing. Until now the customer was told
      // "approved" and heard nothing again, while the money sat waiting for
      // someone to enter it at the bank.
      subtext:
        "Your refund has been sent to your bank. It usually appears on your original payment method within 2 business days, depending on your bank.",
      detailRowsHtml: rows,
      ctaLabel: "View Order",
      ctaHref: ACCOUNT_URL,
      footerNote: "You're receiving this because you returned an item to UpCell.",
    }),
  };
}

function adminNewTradeInEmail({ name, email, phone, modelTitle, storage, estimate, requestId }) {
  const rows =
    detailRow("Device", escapeHtml(modelTitle)) +
    detailRow("Storage", escapeHtml(storage)) +
    detailRow("Estimate", money(estimate)) +
    detailRow("Customer", escapeHtml(name)) +
    detailRow("Email", escapeHtml(email)) +
    detailRow("Phone", escapeHtml(phone), { bordered: false });

  return {
    subject: "New trade-in request received",
    html: emailShell({
      preheader: `${name} submitted a trade-in request for ${modelTitle} — ${money(estimate)}.`,
      badgeGlyph: "&#128241;",
      headline: "New trade-in request",
      subtext: "A customer just submitted a trade-in request. Here are the details.",
      detailRowsHtml: rows,
      ctaLabel: "View Request",
      ctaHref: adminTradeInUrl(requestId),
      footerNote: "You're receiving this because you're listed as an UpCell trade-in admin.",
    }),
  };
}

function adminTradeInStatusEmail({ name, email, phone, modelTitle, storage, status, estimate, requestId }) {
  const rows =
    detailRow("Device", escapeHtml(modelTitle)) +
    detailRow("Storage", escapeHtml(storage)) +
    detailRow("Estimate", money(estimate)) +
    detailRow("Customer", escapeHtml(name)) +
    detailRow("Email", escapeHtml(email)) +
    detailRow("Phone", escapeHtml(phone)) +
    detailRow("New Status", escapeHtml(status), { bordered: false, valueColor: RED, valueWeight: 700 });

  return {
    subject: `Trade-in status updated: ${status}`,
    html: emailShell({
      preheader: `Request ${requestId} for ${name} moved to "${status}".`,
      badgeGlyph: status === "Paid" ? "&#10003;" : "&#128260;",
      headline: `Trade-in status updated: <span style="color:${RED};">${escapeHtml(status)}</span>`,
      subtext: "A trade-in request you're tracking just changed status.",
      detailRowsHtml: rows,
      ctaLabel: "View Request",
      ctaHref: adminTradeInUrl(requestId),
      footerNote: "You're receiving this because you're listed as an UpCell trade-in admin.",
    }),
  };
}

function adminNewOrderEmail({ orderId, paidWith, name, email }) {
  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Paid With", escapeHtml(paidWith)) +
    detailRow("Customer", escapeHtml(name)) +
    detailRow("Email", escapeHtml(email), { bordered: false });

  return {
    subject: "New order on UpCell",
    html: emailShell({
      preheader: `New order from ${name} — paid with ${paidWith}.`,
      badgeGlyph: "&#128722;",
      headline: "New order on UpCell",
      subtext: "A new order just came in. Here are the details.",
      detailRowsHtml: rows,
      ctaLabel: "View All Orders",
      ctaHref: ADMIN_ORDERS_URL,
      footerNote: "You're receiving this because you're listed as an UpCell order admin.",
    }),
  };
}

function adminOrderStatusEmail({ orderId, status, name, email }) {
  const rows =
    detailRow("Order ID", `#${escapeHtml(orderId)}`) +
    detailRow("Customer", escapeHtml(name)) +
    detailRow("Email", escapeHtml(email)) +
    detailRow("New Status", escapeHtml(status), { bordered: false, valueColor: RED, valueWeight: 700 });

  return {
    subject: `Order status updated: ${status}`,
    html: emailShell({
      preheader: `Order #${orderId} is now ${status}.`,
      badgeGlyph: ORDER_STATUS_BADGE[status] || "&#128230;",
      headline: `Order status updated: <span style="color:${RED};">${escapeHtml(status)}</span>`,
      subtext: "An order you're tracking just changed status.",
      detailRowsHtml: rows,
      ctaLabel: "View All Orders",
      ctaHref: ADMIN_ORDERS_URL,
      footerNote: "You're receiving this because you're listed as an UpCell order admin.",
    }),
  };
}

function adminErrorAlertEmail() {
  return {
    subject: "A little hiccup on the UpCell site",
    html: emailShell({
      preheader: "Nothing urgent — our system flagged something for a developer to look at.",
      badgeGlyph: "&#128295;",
      headline: "A little hiccup on the site",
      subtext: "Nothing to worry about &mdash; something on the site needs a developer&rsquo;s eye. They&rsquo;ve already been notified and will take a look soon. No action needed from you right now.",
      detailRowsHtml: "",
      ctaLabel: "Open Admin Dashboard",
      ctaHref: `${FRONTEND_URL}/admin-secret`,
      footerNote: "You're receiving this because you're listed as an UpCell site admin.",
    }),
  };
}

// Unlike adminErrorAlertEmail, this one is deliberately specific. A payment
// problem needs the admin to know which orders to look at — a reassuring
// "nothing to worry about" is the wrong tone when money may be involved.
function adminPaymentAlertEmail({ title, summary, lines = [], urgent = false }) {
  const rows = lines
    .map((line) => detailRow("", escapeHtml(line), { valueColor: "#FFFFFF" }))
    .join("");

  return {
    subject: `${urgent ? "Action needed" : "Payment check"}: ${title}`,
    html: emailShell({
      preheader: summary,
      badgeGlyph: urgent ? "&#9888;" : "&#128176;",
      headline: title,
      subtext: escapeHtml(summary),
      detailRowsHtml: rows ? detailRowsBox(rows) : "",
      ctaLabel: "Open Admin Dashboard",
      ctaHref: `${FRONTEND_URL}/admin-secret`,
      footerNote: "You're receiving this because you're listed as an UpCell site admin.",
    }),
  };
}

// Sent when someone uses the contact form. Until this existed the message was
// saved to the database and nobody was told, so it was only seen if an admin
// happened to open the contact page and look.
//
// The customer's own message is included in full: making someone log in to
// read it means slower replies, which is the whole point of a contact form.
function adminNewContactEmail({ name, email, subject, message, submissionId }) {
  const rows =
    detailRow("From", escapeHtml(name)) +
    detailRow("Email", escapeHtml(email)) +
    detailRow("Subject", escapeHtml(subject), { bordered: false });

  return {
    subject: `New message: ${subject}`,
    html: emailShell({
      preheader: `${name} sent a message through the contact form`,
      badgeGlyph: "&#9993;",
      headline: "New contact message",
      subtext:
        "Someone got in touch through the website. Their message is below — " +
        "you can reply to them directly at the address shown.",
      detailRowsHtml:
        detailRowsBox(rows) +
        `<tr><td style="padding:16px 0 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:#FFFFFF;white-space:pre-wrap;">${escapeHtml(
          message
        )}</td></tr>`,
      ctaLabel: "Open Admin Dashboard",
      ctaHref: `${FRONTEND_URL}/admin-secret/contact`,
      footerNote: "You're receiving this because you're listed as an UpCell site admin.",
    }),
  };
}

module.exports = {
  emailShell,
  adminNewContactEmail,
  adminPaymentAlertEmail,
  tradeInRequestEmail,
  tradeInStatusEmail,
  orderPlacedEmail,
  orderStatusEmail,
  paymentReceiptEmail,
  refundApprovedEmail,
  refundRequestReceivedEmail,
  returnLabelIssuedEmail,
  orderShippedEmail,
  orderLinkEmail,
  revisedOfferEmail,
  returnReminderEmail,
  returnExpiredEmail,
  refundReturnInstructionsEmail,
  refundDeviceReceivedEmail,
  refundRejectedEmail,
  refundMoneySentEmail,
  adminErrorAlertEmail,
  adminNewTradeInEmail,
  adminTradeInStatusEmail,
  adminNewOrderEmail,
  adminOrderStatusEmail,
};
