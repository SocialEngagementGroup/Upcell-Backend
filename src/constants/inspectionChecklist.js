// What every returned device is checked for, in the same order every time.
//
// A fixed list is the point. Two staff looking at the same phone should record
// the same eleven answers, and a dispute six months later should be answerable
// from the record rather than from whoever happened to open the box. It is also
// what makes returns reportable: "how many came back with a swollen battery"
// is only a question you can ask if everyone answered the same question.
//
// Built as a standalone list rather than inside the returns controller because
// trade-in intake will need the same checks, and the plan is explicit that it
// should call this code rather than grow a second copy.

const RESULTS = ["pass", "fail", "na"];

// One of these is measured rather than answered (battery health, a number),
// and one is graded rather than passed (cosmetic condition, a band). The rest
// are pass / fail / n/a.
const CHECKLIST_ITEMS = [
  {
    key: "imei_matches",
    label: "IMEI / serial matches the order",
    // The only thing tying the device on the bench to the line on the order.
    // A mismatch is not a grading question, it is a different device.
    critical: true,
  },
  {
    key: "activation_lock",
    label: "Activation Lock / Find My iPhone is off",
    // A locked device cannot be resold, returned to the supplier, or
    // wholesaled. It is worth nothing to anyone until the customer removes it,
    // which takes them two minutes from their phone.
    critical: true,
    blocksOn: "fail",
  },
  { key: "powers_on", label: "Powers on and boots" },
  { key: "screen_touch", label: "Screen and touch respond" },
  {
    key: "battery_health",
    label: "Battery health % — recorded, never a deduction",
    // Written down because the next buyer needs it, and because a return can
    // be compared against what it sold at. It can never move the grade or take
    // money off: battery decline is normal wear, and charging for it would be
    // charging a customer for physics.
    measured: true,
    neverDeducts: true,
  },
  {
    key: "cosmetic_grade",
    label: "Cosmetic grade — Excellent / Good / Fair / Fail",
    // Graded rather than passed or failed. It is one of the two axes the final
    // grade is the lower of, and the only one a regrade reads.
    graded: true,
  },
  { key: "liquid_damage", label: "Liquid damage indicator clear" },
  {
    key: "matches_grade_sold",
    label: "Cosmetic condition still matches the grade it sold at",
    // The question the whole regrade turns on. UpCell sells used devices, so
    // every one has been opened — what matters is whether it came back looking
    // the way the listing said it looked.
    drivesDisposition: true,
  },
  {
    key: "unlocked",
    label: "Device is unlocked and carrier-free",
    // A confirmation that it came back as it left, not an assessment: UpCell
    // only sells unlocked devices in the first place.
  },
  {
    key: "fault_reproduced",
    label: "Reported fault reproduced",
    // Only meaningful when the customer claimed one. "na" is the right answer
    // for a change-of-mind return, and a fault that does not reproduce is what
    // re-attributes the return and triggers a revised offer.
    onlyWhenFaultClaimed: true,
  },
];

const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((item) => item.key);

// The photos that have to exist before an inspection can be submitted. Five,
// because these are the five that answer the arguments that actually happen:
// what condition it arrived in, that it was the right device, and that it
// powered on when UpCell said it did.
const REQUIRED_PHOTO_COUNT = 5;

const PHOTO_GUIDANCE = [
  "Front of the device",
  "Back of the device",
  "Screen, powered on",
  "IMEI or settings screen",
  "Any damage found",
];

// How long inspection photos are kept.
//
// 90 days covers the window in which a settled return turns into a question.
// A return that went wrong — rejected, reduced, or disputed — keeps its photos
// until the case closes, because those are the ones that end up in an argument
// months later. See PHOTO_HOLD_STATUSES in constants/returnStatus.js.
const PHOTO_RETENTION_DAYS = 90;

const GRADES = ["A", "B", "C", "FAIL"];

const isChecklistKey = (key) => CHECKLIST_KEYS.includes(key);
const checklistItem = (key) => CHECKLIST_ITEMS.find((item) => item.key === key) || null;

module.exports = {
  CHECKLIST_ITEMS,
  CHECKLIST_KEYS,
  RESULTS,
  GRADES,
  REQUIRED_PHOTO_COUNT,
  PHOTO_GUIDANCE,
  PHOTO_RETENTION_DAYS,
  isChecklistKey,
  checklistItem,
};
