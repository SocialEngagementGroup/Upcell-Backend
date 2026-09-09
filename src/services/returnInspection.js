// Turning eleven answers and five photos into a decision.
//
// The service suggests; a person decides. Everything here produces a
// recommendation that staff can override with a reason — the point is that the
// easy cases stop needing thought, not that the hard ones get decided by a
// lookup table. A device that arrives locked, or that is not the device that
// was sold, has an obvious answer and should not depend on who opened the box.

const {
  CHECKLIST_ITEMS,
  CHECKLIST_KEYS,
  RESULTS,
  REQUIRED_PHOTO_COUNT,
  PHOTO_RETENTION_DAYS,
  isChecklistKey,
} = require("../constants/inspectionChecklist");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this inspection can be submitted at all.
 *
 * Refuses rather than warns. An inspection with three answers and two photos is
 * not a faster inspection, it is an unusable record — and the moment it matters
 * is months later, when nobody can go back and look at the device again.
 */
function validateInspection({ checklist = [], photos = [], faultClaimed = false }) {
  const errors = [];

  const answered = new Map();
  for (const entry of checklist) {
    if (!isChecklistKey(entry?.key)) {
      errors.push(`"${entry?.key}" is not one of the checks.`);
      continue;
    }
    if (!RESULTS.includes(entry?.result)) {
      errors.push(`${entry.key} must be answered pass, fail or na.`);
      continue;
    }
    answered.set(entry.key, entry);
  }

  for (const item of CHECKLIST_ITEMS) {
    // The fault check only means something when a fault was claimed. Demanding
    // an answer on a change-of-mind return would train staff to type "na"
    // eleven times, which is how a checklist stops being read.
    if (item.onlyWhenFaultClaimed && !faultClaimed) continue;
    if (!answered.has(item.key)) errors.push(`"${item.label}" has not been answered.`);
  }

  const usable = photos.filter((photo) => photo?.publicId || photo?.url);
  if (usable.length < REQUIRED_PHOTO_COUNT) {
    errors.push(
      `At least ${REQUIRED_PHOTO_COUNT} photos are required — ${usable.length} attached.`
    );
  }

  // A photo with no Cloudinary id can never be deleted, so it would sit in the
  // account forever and quietly break the 90-day purge.
  if (photos.some((photo) => photo?.url && !photo?.publicId)) {
    errors.push("Every photo needs its Cloudinary id, or it can never be deleted.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, checklist: [...answered.values()] };
}

const resultOf = (checklist, key) => checklist.find((entry) => entry.key === key)?.result;

/**
 * What the inspection points to, before anyone overrides it.
 *
 * Three outcomes, in the order they are checked:
 *
 *   ACTION_REQUIRED  something only the customer can fix. Activation Lock is
 *                    the whole reason this state exists — rejecting a locked
 *                    device costs postage and starts an argument over a problem
 *                    the customer can clear in two minutes.
 *   REJECT           the device is not the one that was sold, or is beyond use.
 *   REVISED_OFFER    worse than described, but still worth something.
 *   FULL_REFUND      as described.
 */
function suggestOutcome({ checklist = [], reasonCode, faultClaimed = false }) {
  const failed = (key) => resultOf(checklist, key) === "fail";

  if (failed("activation_lock")) {
    return {
      outcome: "ACTION_REQUIRED",
      reason:
        "Activation Lock is still on. The device cannot be resold, returned to the supplier or wholesaled until the customer removes it.",
    };
  }

  if (failed("imei_matches")) {
    return {
      outcome: "REJECT",
      reason: "The IMEI does not match the order — this is not the device that was sold.",
    };
  }

  if (failed("liquid_damage")) {
    return {
      outcome: "REJECT",
      reason: "The liquid damage indicator has triggered.",
    };
  }

  // A fault that was claimed and does not reproduce re-attributes the return:
  // it stops being UpCell's fault, which changes both the postage and the fee.
  // That is exactly the case a revised offer exists for.
  if (faultClaimed && resultOf(checklist, "fault_reproduced") === "fail") {
    return {
      outcome: "REVISED_OFFER",
      reason:
        "The reported fault did not reproduce, so this is a change-of-mind return rather than a faulty one.",
    };
  }

  const condition = ["powers_on", "screen_touch", "battery_health", "body_condition", "accessories"]
    .filter(failed);

  if (condition.length) {
    return {
      outcome: "REVISED_OFFER",
      reason: `The device is in worse condition than described (${condition.join(", ")}).`,
    };
  }

  return { outcome: "FULL_REFUND", reason: "The device is as described." };
}

/**
 * The disposition the checklist points to.
 *
 * Only the sealed case is decided here. Everything else needs a human, because
 * where an opened-but-perfect device goes is a commercial decision about
 * supplier terms and wholesale rates, not something a checklist knows.
 */
function suggestDisposition({ checklist = [], outcome }) {
  if (outcome === "REJECT") return null;

  if (resultOf(checklist, "seal_intact") === "pass") {
    return {
      type: "RESTOCK_NEW",
      reason: "The factory seal is unbroken, so this is still a new device.",
    };
  }

  if (resultOf(checklist, "powers_on") === "fail") {
    return {
      type: "RETURN_TO_SUPPLIER",
      reason: "The device does not power on — recover the cost from the supplier where terms allow.",
    };
  }

  // Opened but working. The plan's working default until UpCell decides where
  // these actually go; recorded as OPEN_BOX either way, so changing the
  // destination later is a policy change rather than a rebuild.
  return {
    type: "OPEN_BOX",
    reason: "Opened but in working order. Routed to wholesale until UpCell decides otherwise.",
  };
}

/**
 * A letter grade for the device, from the condition answers.
 *
 * Used for wholesale batching and for reporting, not for the refund — money
 * comes from the itemised deductions, each tied to a finding, so that a
 * customer asking "why is this less" gets a list rather than a letter.
 */
function gradeFrom(checklist = []) {
  const failed = (key) => resultOf(checklist, key) === "fail";

  if (failed("imei_matches") || failed("liquid_damage") || failed("powers_on")) return "FAIL";

  const cosmetic = ["body_condition", "accessories"].filter(failed).length;
  const functional = ["screen_touch", "battery_health"].filter(failed).length;

  if (functional) return "C";
  if (cosmetic >= 2) return "C";
  if (cosmetic === 1) return "B";
  return "A";
}

/**
 * When each photo may be deleted.
 *
 * A flat 90 days at upload. The indefinite hold for a rejected, reduced or
 * disputed return is applied by the purge job reading the request's status, not
 * by rewriting every photo when the status changes — a hold that has to be
 * written to fifty rows is a hold that gets missed.
 */
function stampPurgeDates(photos = [], now = new Date()) {
  const purgeAfter = new Date(now.getTime() + PHOTO_RETENTION_DAYS * DAY_MS);

  return photos.map((photo) => ({
    url: photo.url,
    publicId: photo.publicId,
    caption: photo.caption,
    takenAt: photo.takenAt ? new Date(photo.takenAt) : now,
    purgeAfter,
  }));
}

module.exports = {
  validateInspection,
  suggestOutcome,
  suggestDisposition,
  gradeFrom,
  stampPurgeDates,
  CHECKLIST_KEYS,
};
