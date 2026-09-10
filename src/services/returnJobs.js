// The things that have to happen to a return when nobody is looking at it.
//
// Four jobs, run daily: nudge customers before their authorisation lapses,
// expire the ones that lapsed anyway, auto-decline a revised offer nobody
// answered, and delete inspection photos once their retention is up. The first
// three exist because a return left alone does not resolve itself — it sits in
// a queue looking live, and staff cannot tell it apart from one still on its
// way. The fourth exists because evidence photos of somebody's device are not
// something to keep forever by accident.
//
// Every dependency is passed in rather than required at the top. That is what
// lets these be tested against dates and fake records without a database or a
// mail server, which matters more here than anywhere else in the returns code:
// these run unattended, and a bug in them emails real customers the wrong
// thing at three in the morning.

const { dueReminder, hasExpired } = require("./returnAuthorisation");
const { offerHasExpired } = require("./revisedOffer");
const { applyTransition, recordEvent } = require("./returnTimeline");
const { photosAreHeld } = require("../constants/returnStatus");

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

// How many times a delete is retried inside one run before it is left for the
// next one. Two is enough to ride out a blip without hammering an API that is
// genuinely down — a run that cannot reach Cloudinary at all should finish and
// report, not spin.
const PURGE_RETRIES = 2;

/**
 * Deletes inspection photos once their 90 days are up.
 *
 * The hold is the important half, and destroyAsset's prefix guard is the other:
 * nothing here can reach an asset outside the returns tree, so a bug in this
 * loop cannot delete the catalogue.
 *
 * A delete that fails is retried twice, then left alone and reported — never
 * marked done. Marking it gone would lose the only handle we have on an asset
 * still sitting in the account, and a run that cannot reach Cloudinary at all
 * becomes visible rather than looking like a successful purge of nothing.
 */
async function purgeInspectionPhotos({ RefundRequest, destroyAsset, now = new Date() }) {
  const candidates = await RefundRequest.find({
    "inspection.photos.purgeAfter": { $lt: now },
  });

  let deleted = 0;
  let held = 0;
  let refused = 0;
  const failures = [];

  for (const request of candidates) {
    const hold = photosAreHeld(request);
    if (hold.held) {
      // Nothing is deleted and the photos keep their original purge dates, so
      // they are reconsidered once the case closes rather than being kept
      // forever by accident.
      held += (request.inspection?.photos || []).length;
      continue;
    }

    const remaining = [];
    let removedHere = 0;

    for (const photo of request.inspection?.photos || []) {
      const due = photo.purgeAfter && new Date(photo.purgeAfter).getTime() < now.getTime();

      if (!due) {
        remaining.push(photo);
        continue;
      }

      let result = null;
      for (let attempt = 0; attempt <= PURGE_RETRIES; attempt += 1) {
        result = await destroyAsset(photo.publicId);
        if (result.ok) break;
        // A refusal is not a blip. The id is outside the returns tree, and
        // retrying will refuse again — so stop and report it loudly.
        if (result.refused) break;
      }

      if (!result.ok) {
        remaining.push(photo);
        if (result.refused) refused += 1;
        failures.push({
          requestId: String(request._id),
          publicId: photo.publicId,
          error: result.error,
          refused: Boolean(result.refused),
        });
        continue;
      }

      removedHere += 1;
    }

    if (!removedHere) continue;

    request.inspection.photos = remaining;
    // Recorded as an event rather than silently: "where did the photos go" is
    // a question somebody asks, and the answer has to be in the record.
    recordEvent(request, {
      event: "inspection_photos_purged",
      actor: "system",
      actorType: "system",
      meta: { deleted: removedHere, remaining: remaining.length },
    });
    await request.save();

    deleted += removedHere;
  }

  // A refusal means something tried to delete outside the returns tree. That
  // is a bug rather than a bad day, and it should be loud.
  if (refused) {
    console.error(`[returns] purge refused ${refused} deletes outside the returns folder`);
  }

  return { deleted, held, refused, failures, considered: candidates.length };
}

module.exports = {
  purgeInspectionPhotos,
  // Re-exported so the job and its tests read the rule from one place.
  photosAreHeld,
  sendDueReminders,
  expireStaleAuthorisations,
  autoDeclineStaleOffers,
  AWAITING_SHIPMENT,
};
