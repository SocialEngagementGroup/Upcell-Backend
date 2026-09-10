// When the return window opens, and when it shuts.
//
// The window is 30 days for every reason. The only hard part is deciding what
// day one is, and that matters more than it sounds: a customer whose parcel sat
// in a depot for a week should not lose a week of their window, and UpCell
// should not be arguing about it after the fact.
//
// Three sources, in order of how much they can be trusted:
//
//   DELIVERY        the carrier says it arrived. The real answer.
//   SHIP_PLUS_3     it shipped, nobody recorded delivery. Three days is the
//                   normal transit time, so this is a fair estimate.
//   STAFF_OVERRIDE  a person looked and set the date, with a note saying why.
//
// The order date is deliberately not on that list. An order placed on the 1st
// and delivered on the 10th would quietly eat nine days of the customer's
// window, and it is the one fallback that looks reasonable until you notice
// what it costs them.

const RETURN_WINDOW_DAYS = 30;

// Normal transit. Used only when a delivery was never recorded.
const SHIP_TO_DELIVERY_DAYS = 3;

// Damage in transit has to be reported quickly, because after a few days
// nobody can tell a courier's dent from a kitchen-counter dent. Business days,
// so a Friday delivery does not eat the window over a weekend.
const TRANSIT_CLAIM_BUSINESS_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const isWeekend = (date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;

/**
 * Business days from one date to another, not counting the start.
 *
 * Deliberately does not know about public holidays. A hard-coded list is wrong
 * the year after it is written, and counting a holiday as a working day is the
 * harmless direction — it shortens a claim window by a day rather than letting
 * a late claim through.
 */
function businessDaysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) return 0;

  let days = 0;
  const cursor = new Date(start.getTime());

  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isWeekend(cursor) && cursor <= end) days += 1;
  }

  return days;
}

/**
 * When the customer's 30 days started, and where that date came from.
 *
 * @returns {{startedFrom, startDate, expiresAt} | null}  null when the order
 *          has neither shipped nor been delivered — the window has not begun,
 *          which is not the same as having expired.
 */
function resolveWindowStart(order, { override } = {}) {
  // A person looked and decided. Beats both automatic sources, because they
  // have information the record does not — a customer's email saying when it
  // actually turned up, most often.
  if (override?.startDate) {
    const startDate = new Date(override.startDate);
    return {
      startedFrom: "STAFF_OVERRIDE",
      startDate,
      expiresAt: new Date(startDate.getTime() + RETURN_WINDOW_DAYS * DAY_MS),
      overrideBy: override.by,
      overrideNote: override.note,
    };
  }

  if (order?.deliveredAt) {
    const startDate = new Date(order.deliveredAt);
    return {
      startedFrom: "DELIVERY",
      startDate,
      expiresAt: new Date(startDate.getTime() + RETURN_WINDOW_DAYS * DAY_MS),
    };
  }

  if (order?.shippedAt) {
    const startDate = new Date(new Date(order.shippedAt).getTime() + SHIP_TO_DELIVERY_DAYS * DAY_MS);
    return {
      startedFrom: "SHIP_PLUS_3",
      startDate,
      expiresAt: new Date(startDate.getTime() + RETURN_WINDOW_DAYS * DAY_MS),
    };
  }

  return null;
}

/**
 * Whether a staff override is allowed to stand.
 *
 * The note is not paperwork. Overriding this date moves money — it decides
 * whether a return is inside the window — and with two or three staff able to
 * do it, an unexplained override is indistinguishable from a favour.
 */
function validateOverride({ startDate, note, by }) {
  if (!startDate || Number.isNaN(new Date(startDate).getTime())) {
    return { ok: false, error: "Enter the date the customer actually received it." };
  }

  if (new Date(startDate).getTime() > Date.now()) {
    return { ok: false, error: "The window cannot start in the future." };
  }

  if (String(note || "").trim().length < 10) {
    return {
      ok: false,
      error: "Say why you are changing this date — an unexplained override cannot be defended later.",
    };
  }

  return {
    ok: true,
    override: { startDate: new Date(startDate), note: String(note).trim(), by },
  };
}

/**
 * Whether a transit-damage claim is still in time.
 *
 * Counted in business days from delivery. A Friday delivery leaves the same
 * three working days a Monday one does.
 */
function transitClaimInTime(order, { now = new Date() } = {}) {
  if (!order?.deliveredAt) {
    // Never recorded as delivered, so the clock has not started. Refusing here
    // would punish the customer for a missing scan.
    return { ok: true, reason: "no_delivery_recorded" };
  }

  const elapsed = businessDaysBetween(order.deliveredAt, now);

  if (elapsed > TRANSIT_CLAIM_BUSINESS_DAYS) {
    return {
      ok: false,
      reason: "too_late",
      message: `Damage in transit has to be reported within ${TRANSIT_CLAIM_BUSINESS_DAYS} business days of delivery. This was delivered ${elapsed} business days ago.`,
      businessDaysElapsed: elapsed,
    };
  }

  return { ok: true, businessDaysElapsed: elapsed };
}

module.exports = {
  RETURN_WINDOW_DAYS,
  SHIP_TO_DELIVERY_DAYS,
  TRANSIT_CLAIM_BUSINESS_DAYS,
  businessDaysBetween,
  resolveWindowStart,
  validateOverride,
  transitClaimInTime,
};
