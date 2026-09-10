// Turning eleven answers and five photos into a decision.
//
// The service suggests; a person decides. Everything here produces a
// recommendation that staff can override with a reason — the point is that the
// easy cases stop needing thought, not that the hard ones get decided by a
// lookup table. A device that arrives locked, or that is not the device that
// was sold, has an obvious answer and should not depend on who opened the box.

const { GRADES, batteryBand, finalGrade, regradeOnReturn } = require("../constants/grading");
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

    const item = CHECKLIST_ITEMS.find((candidate) => candidate.key === entry.key);

    // Battery health is a number, not a verdict. Asking for pass or fail on it
    // would be asking the inspector to make the judgement the policy forbids.
    if (item?.measured) {
      const value = Number(entry.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        errors.push("Battery health must be a percentage between 0 and 100.");
        continue;
      }
      answered.set(entry.key, { key: entry.key, value, note: entry.note });
      continue;
    }

    // Cosmetic condition is a band, not a pass. It is one of the two axes the
    // final grade is the lower of.
    if (item?.graded) {
      if (!Object.values(GRADES).includes(entry.grade)) {
        errors.push(`Cosmetic grade must be one of: ${Object.values(GRADES).join(", ")}.`);
        continue;
      }
      answered.set(entry.key, { key: entry.key, grade: entry.grade, note: entry.note });
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
function suggestOutcome({ checklist = [], reasonCode, faultClaimed = false, ...options }) {
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

  // Worse than it sold at, cosmetically. Battery is deliberately not in this
  // list: a device whose battery fell is not in worse condition, it is a used
  // device that was used.
  const gradeAtSale = options.gradeAtSale;
  const cosmeticGrade = checklist.find((entry) => entry.key === "cosmetic_grade")?.grade;

  if (gradeAtSale && cosmeticGrade) {
    const regrade = regradeOnReturn({ gradeAtSale, cosmeticGrade });
    if (regrade.regraded) {
      return {
        outcome: "REVISED_OFFER",
        reason: regrade.reason,
        regrade,
      };
    }
  }

  const broken = ["powers_on", "screen_touch"].filter(failed);
  if (broken.length) {
    return {
      outcome: "REVISED_OFFER",
      reason: `The device does not work as described (${broken.join(", ")}).`,
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
function suggestDisposition({ checklist = [], outcome, gradeAtSale }) {
  if (outcome === "REJECT") return null;

  const cosmeticGrade = checklist.find((entry) => entry.key === "cosmetic_grade")?.grade;

  if (cosmeticGrade === GRADES.FAIL) {
    return { type: "SCRAP", reason: "Cracked, liquid damaged, or structurally damaged." };
  }

  if (resultOf(checklist, "powers_on") === "fail") {
    return {
      type: "RETURN_TO_SUPPLIER",
      reason: "The device does not power on — recover the cost from the supplier where terms allow.",
    };
  }

  // The common case, and the whole reason per-unit records make this simple:
  // the device goes back onto its own listing. Only the grade decides whether
  // it goes back unchanged or re-priced.
  const regrade = regradeOnReturn({ gradeAtSale, cosmeticGrade });

  return {
    type: regrade.disposition === "SCRAP" ? "SCRAP" : regrade.disposition,
    grade: regrade.to,
    reason: regrade.reason,
    regraded: regrade.regraded,
  };
}

/**
 * The grade the device gets, from the two axes.
 *
 * Used for relisting and reporting, not for the refund — money comes from
 * itemised deductions each tied to a finding and a photo, so a customer asking
 * "why is this less" gets a list rather than a letter.
 */
function gradeFrom(checklist = []) {
  const failed = (key) => resultOf(checklist, key) === "fail";

  if (failed("imei_matches") || failed("liquid_damage") || failed("powers_on")) {
    return GRADES.FAIL;
  }

  const batteryHealth = checklist.find((entry) => entry.key === "battery_health")?.value;
  const cosmeticGrade = checklist.find((entry) => entry.key === "cosmetic_grade")?.grade;

  return finalGrade({ batteryHealth, cosmeticGrade });
}

/** The battery reading, for the record and the relisting. Never a grade input
 * on a return, and never a deduction. */
const batteryHealthFrom = (checklist = []) =>
  checklist.find((entry) => entry.key === "battery_health")?.value ?? null;

const cosmeticGradeFrom = (checklist = []) =>
  checklist.find((entry) => entry.key === "cosmetic_grade")?.grade ?? null;

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
  batteryHealthFrom,
  cosmeticGradeFrom,
  batteryBand,
  suggestOutcome,
  suggestDisposition,
  gradeFrom,
  stampPurgeDates,
  CHECKLIST_KEYS,
};
