// Wires the returns jobs to the real model and the real mailer.
//
// Kept apart from returnJobs.js so that file stays free of imports and can be
// tested against fake records — these run unattended, and a bug in them emails
// real customers the wrong thing at three in the morning.
const { Resend } = require("resend");
const RefundRequest = require("../models/refundRequest.model");
const Order = require("../models/order.model");
const { TradeInRequest } = require("../models/tradeInRequest.model");
const tradeInStatus = require("../constants/tradeInStatus");
const {
  returnReminderEmail,
  returnExpiredEmail,
  reviewPromptEmail,
} = require("./emailTemplates");
const {
  sendDueReminders,
  expireStaleAuthorisations,
  autoDeclineStaleOffers,
  purgeInspectionPhotos,
  sendReviewPrompts,
  autoDeclineStaleTradeInOffers,
} = require("./returnJobs");
const { destroyAsset } = require("./cloudinaryDelete");

const resend = new Resend(process.env.RESEND_KEY);

// Fire-and-forget, matching every other send in the project. A reminder that
// failed to send must not stop the request being marked as reminded — the
// alternative is emailing the same customer on every run until the mail server
// recovers.
function sendEmail(to, built) {
  if (!to || !built) return;
  resend.emails
    .send({ from: process.env.EMAIL_FROM, to: [to], subject: built.subject, html: built.html })
    .catch((error) => console.error("[returns] email failed:", error?.message || error));
}

/**
 * One pass of everything a return needs when nobody is looking at it.
 *
 * Each job is run independently: reminders failing must not stop
 * authorisations expiring, because a queue full of returns that lapsed weeks
 * ago is worse than a missed nudge.
 */
async function runReturnJobs(now = new Date()) {
  const report = {};

  const jobs = [
    ["reminders", () => sendDueReminders({
      RefundRequest, sendEmail, buildEmail: returnReminderEmail, now,
    })],
    ["expiries", () => expireStaleAuthorisations({
      RefundRequest, sendEmail, buildEmail: returnExpiredEmail, now,
    })],
    ["staleOffers", () => autoDeclineStaleOffers({ RefundRequest, now })],
    ["photoPurge", () => purgeInspectionPhotos({ RefundRequest, destroyAsset, now })],
    // Not a returns job, but it runs on the same daily pass and for the same
    // reason: it is something that has to happen to an order when nobody is
    // looking at it.
    ["reviewPrompts", () => sendReviewPrompts({
      Order, sendEmail, buildEmail: reviewPromptEmail, now,
    })],
    // A trade-in offer nobody answered. Declining it sends the device home,
    // which is kinder than holding it indefinitely while the customer hears
    // nothing.
    ["staleTradeInOffers", () => autoDeclineStaleTradeInOffers({ TradeInRequest, tradeInStatus, now })],
  ];

  for (const [name, run] of jobs) {
    try {
      report[name] = await run();
    } catch (error) {
      report[name] = { error: error?.message || String(error) };
      console.error(`[returns] ${name} failed:`, error?.message || error);
    }
  }

  return report;
}

module.exports = { runReturnJobs };
