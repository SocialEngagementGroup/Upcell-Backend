// What happens after the 30 days run out.
//
// A return and a warranty claim look the same to a customer — something is
// wrong with the phone and they want it dealt with — and they are not the same
// thing at all. Inside 30 days a customer can send a device back because they
// changed their mind, and the answer is money. After 30 days and for the rest
// of the first year they can send it back because it is broken, and the answer
// is a working phone: repaired, replaced, and only as an exception refunded.
//
// Getting that distinction wrong in either direction is expensive. Treating a
// month-eight fault as a return means refunding a device that has been used
// for eight months. Treating it as nothing at all means the twelve-month
// warranty UpCell advertises does not exist.

const { RETURN_REASONS } = require("../constants/returnReasons");
const { RETURN_WINDOW_DAYS, resolveWindowStart } = require("./returnWindow");

const DAY_MS = 24 * 60 * 60 * 1000;

// Twelve months from the day it arrived. Counted from the same date the return
// window is counted from, for the same reason: a parcel that sat in a depot
// for a week should not eat a week of anybody's cover.
const WARRANTY_DAYS = 365;

// What a warranty claim can be about.
//
// Hardware faults only, and not the ones that are claims about arrival — a
// phone cannot be damaged in transit in month eight, and it cannot arrive
// Activation Locked eight months after it arrived. Those belong to the 30-day
// window and stay there.
//
// Derived from the reason list rather than written out again, so a fault code
// added to returnReasons.js is covered here without anybody remembering to
// come back. The two exclusions are named explicitly because they are
// judgements, not a rule that can be derived.
const ARRIVAL_ONLY = ["PHYSICAL_DAMAGE_ON_ARRIVAL", "ACTIVATION_LOCKED"];

const WARRANTY_REASON_CODES = Object.entries(RETURN_REASONS)
  .filter(([code, reason]) => reason.category === "PRODUCT_FAULT" && !ARRIVAL_ONLY.includes(code))
  .map(([code]) => code);

// What staff can decide about a warranty claim.
//
// The order matters: repair first, replace second, refund last and named as an
// exception, because that is the order they should be considered in. A phone
// that can be fixed is fixed.
const WARRANTY_OUTCOMES = ["REPAIR", "REPLACE", "REFUND_EXCEPTION"];

const isWarrantyReason = (code) => WARRANTY_REASON_CODES.includes(code);

/**
 * When the twelve months are up.
 *
 * Derived rather than stored. A stored copy would be null on every order
 * already in the database, and a null here reads as "no warranty" — which is
 * both wrong and the dangerous direction to be wrong in. Derived, an order
 * from last month has the cover it was sold with, whether or not anybody ran
 * a migration.
 *
 * @returns {Date|null} null when the order has neither shipped nor been
 *          delivered, so the clock has not started.
 */
function warrantyExpiresAt(order, { override } = {}) {
  const window = resolveWindowStart(order, { override });
  if (!window) return null;

  return new Date(window.startDate.getTime() + WARRANTY_DAYS * DAY_MS);
}

/**
 * Which of the two this is: a return, a warranty claim, or neither.
 *
 * One function rather than two checks in the caller, because "after the return
 * window" and "inside the warranty" are the same moment described twice, and
 * anywhere they are worked out separately they can disagree.
 *
 * @returns {{kind: "RETURN"|"WARRANTY"|"EXPIRED"|"NOT_STARTED", closesAt, warrantyEndsAt}}
 */
function claimKind(order, { now = new Date(), override } = {}) {
  const window = resolveWindowStart(order, { override });

  if (!window) {
    return { kind: "NOT_STARTED", closesAt: null, warrantyEndsAt: null };
  }

  const closesAt = window.expiresAt;
  const warrantyEndsAt = new Date(window.startDate.getTime() + WARRANTY_DAYS * DAY_MS);

  if (now <= closesAt) return { kind: "RETURN", closesAt, warrantyEndsAt };
  if (now <= warrantyEndsAt) return { kind: "WARRANTY", closesAt, warrantyEndsAt };

  return { kind: "EXPIRED", closesAt, warrantyEndsAt };
}

/**
 * Whether this reason can be claimed under warranty, with something to tell
 * the customer when it cannot.
 *
 * The message names both dates, because a customer told "not eligible" in
 * month eight has no way to work out whether the problem is the reason they
 * picked or the time that has passed.
 */
function checkWarrantyReason(reasonCode, { closesAt, warrantyEndsAt } = {}) {
  if (!reasonCode) {
    return {
      ok: false,
      reason: "reason_required",
      message: "Choose what is wrong with the device. A warranty claim has to say what the fault is.",
    };
  }

  if (isWarrantyReason(reasonCode)) return { ok: true };

  const closed = closesAt ? ` The 30-day return window closed on ${closesAt.toDateString()}.` : "";
  const until = warrantyEndsAt ? ` The warranty runs until ${warrantyEndsAt.toDateString()}.` : "";

  return {
    ok: false,
    reason: "not_a_warranty_reason",
    message:
      `The 12-month warranty covers hardware faults — a device that will not power on, ` +
      `a screen, camera, battery or network problem, or overheating.${closed}${until}`,
  };
}

/**
 * What a warranty outcome pays.
 *
 * Zero, unless somebody explicitly chose to refund as an exception. A repair
 * and a replacement both give the customer a working phone, which is what the
 * warranty promises — paying out as well would be paying twice.
 *
 * The exception exists because the alternative is worse: a device that cannot
 * be repaired, has no replacement in stock, and leaves a customer holding a
 * broken phone and no way out of it.
 */
function warrantyRefundCents(outcome, { orderItemCents = 0 } = {}) {
  if (outcome !== "REFUND_EXCEPTION") return 0;
  return Math.max(0, Math.round(orderItemCents));
}

/**
 * Whether an outcome is one staff are allowed to record.
 */
const isWarrantyOutcome = (outcome) => WARRANTY_OUTCOMES.includes(outcome);

module.exports = {
  WARRANTY_DAYS,
  WARRANTY_REASON_CODES,
  WARRANTY_OUTCOMES,
  RETURN_WINDOW_DAYS,
  warrantyExpiresAt,
  claimKind,
  isWarrantyReason,
  isWarrantyOutcome,
  checkWarrantyReason,
  warrantyRefundCents,
};
