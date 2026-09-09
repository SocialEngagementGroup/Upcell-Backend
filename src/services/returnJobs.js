// The things that have to happen to a return when nobody is looking at it.
//
// Three jobs, run daily: nudge customers before their authorisation lapses,
// expire the ones that lapsed anyway, and auto-decline a revised offer nobody
// answered. All three exist because a return left alone does not resolve
// itself — it sits in a queue looking live, and staff cannot tell it apart from
// one still on its way.
//
// Every dependency is passed in rather than required at the top. That is what
// lets these be tested against dates and fake records without a database or a
// mail server, which matters more here than anywhere else in the returns code:
// these run unattended, and a bug in them emails real customers the wrong
// thing at three in the morning.

const { dueReminder, hasExpired } = require("./returnAuthorisation");
const { offerHasExpired } = require("./revisedOffer");
const { applyTransition, recordEvent } = require("./returnTimeline");

// Statuses where the customer still has the device and the clock is running.
// A return already received cannot expire — UpCell has the phone.
const AWAITING_SHIPMENT = ["ReturnApproved", "LabelIssued"];

/**
 * Day 7 and day 12 nudges.
 *
 * `remindersSent` on the request is what stops a re-run emailing the same
 * customer twice. Written before the send rather than after: a duplicate email
 * annoys someone, while a crash between send and save would send it again on
 * every run until the job stopped crashing.
 */
async function sendDueReminders({ RefundRequest, sendEmail, buildEmail, now = new Date() }) {
  const candidates = await RefundRequest.find({
    status: { $in: AWAITING_SHIPMENT },
    "rma.issuedAt": { $exists: true },
  });

  let sent = 0;

  for (const request of candidates) {
    const day = dueReminder(request, now);
    if (!day) continue;

    const expiresAt = request.rma?.expiresAt;
    const daysLeft = Math.max(
      Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
      0
    );

    request.rma.remindersSent = [...(request.rma.remindersSent || []), day];
    recordEvent(request, {
      event: "reminder_sent",
      actor: "system",
      actorType: "system",
      meta: { day, daysLeft },
    });
    await request.save();

    sendEmail(
      request.email,
      buildEmail({
        rmaNumber: request.rmaNumber,
        daysLeft,
        expiresAt,
        labelUrl: request.shipping?.inbound?.labelUrl,
        trackingNumber: request.shipping?.inbound?.trackingNumber,
      })
    );

    sent += 1;
  }

  return { sent, considered: candidates.length };
}

/**
 * Expires authorisations the customer never used.
 *
 * Only where UpCell does not have the device. A return that was received and
 * is sitting in inspection cannot expire — the phone is here, and the
 * authorisation has already been used for what it was for.
 */
async function expireStaleAuthorisations({ RefundRequest, sendEmail, buildEmail, now = new Date() }) {
  const candidates = await RefundRequest.find({
    status: { $in: AWAITING_SHIPMENT },
    "rma.expiresAt": { $lt: now },
  });

  let expired = 0;

  for (const request of candidates) {
    if (!hasExpired(request, now)) continue;

    const moved = applyTransition(request, "Expired", {
      actor: "system",
      actorType: "system",
      event: "authorisation_expired",
      meta: { expiresAt: request.rma?.expiresAt },
    });

    // A status the map will not allow is a bug worth seeing, not something to
    // force. Skipping leaves the record untouched and the next run tries again.
    if (!moved.ok) continue;

    request.resolution = { ...(request.resolution || {}), outcome: "EXPIRED" };
    await request.save();

    sendEmail(
      request.email,
      buildEmail({ rmaNumber: request.rmaNumber, orderId: String(request.orderId) })
    );

    expired += 1;
  }

  return { expired, considered: candidates.length };
}

/**
 * Declines a revised offer nobody answered inside five days.
 *
 * Silence is a decline, and declining sends the device back — which is the
 * outcome that costs UpCell postage rather than the one that quietly keeps a
 * customer's phone. A device cannot sit indefinitely waiting for someone who
 * has stopped reading their email.
 */
async function autoDeclineStaleOffers({ RefundRequest, now = new Date() }) {
  const candidates = await RefundRequest.find({
    status: "RevisedOffer",
    "refundBreakdown.offerExpiresAt": { $lt: now },
  });

  let declined = 0;

  for (const request of candidates) {
    if (!offerHasExpired(request, now)) continue;

    const moved = applyTransition(request, "Rejected", {
      actor: "system",
      actorType: "system",
      event: "revised_offer_expired",
      meta: { offeredAmount: request.refundBreakdown?.offeredAmount },
    });

    if (!moved.ok) continue;

    request.rejectionReason =
      "The revised refund offer expired without an answer, so the device is being returned.";
    request.resolution = { ...(request.resolution || {}), outcome: "PARTIAL_DECLINED" };
    await request.save();

    declined += 1;
  }

  return { declined, considered: candidates.length };
}

module.exports = {
  sendDueReminders,
  expireStaleAuthorisations,
  autoDeclineStaleOffers,
  AWAITING_SHIPMENT,
};
