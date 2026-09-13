// Why a customer is sending a device back.
//
// The code no longer decides who pays or what is charged, because under the
// current policy neither varies: every return is free, in both directions, and
// there is no restocking fee. What the code still decides is how the return is
// reported, and it still carries an attribution — UpCell's fault or the
// customer's — because that is what surfaces a pattern of bad-faith returns
// when inspection overturns it.
//
// This replaces an earlier policy where a change of mind cost the customer
// postage and 15%. Matching Back Market, which is what UpCell's customers
// compare against, is worth more than the fee was.

const RETURN_REASON_CATEGORIES = {
  PREFERENCE: "PREFERENCE",
  FULFILMENT: "FULFILMENT",
  PRODUCT_FAULT: "PRODUCT_FAULT",
  LOGISTICS: "LOGISTICS",
};

// Every code, with the category it belongs to and the words a customer sees.
// Adding a code here is all that is needed — the category decides how it is
// reported and nothing else has to change.
const RETURN_REASONS = {
  // The customer changed their mind. Still free to return, still no fee — this
  // grouping only separates their choice from UpCell's mistake in the numbers.
  CHANGED_MIND: { category: "PREFERENCE", label: "Changed my mind" },
  FOUND_BETTER_PRICE: { category: "PREFERENCE", label: "Found a better price" },
  NO_LONGER_NEEDED: { category: "PREFERENCE", label: "No longer needed" },

  // UpCell sent the wrong thing.
  WRONG_MODEL: { category: "FULFILMENT", label: "Wrong model sent" },
  WRONG_STORAGE: { category: "FULFILMENT", label: "Wrong storage size sent" },
  WRONG_COLOR: { category: "FULFILMENT", label: "Wrong colour sent" },
  NOT_AS_DESCRIBED: { category: "FULFILMENT", label: "Not as described" },

  // The device itself is faulty.
  WONT_POWER_ON: { category: "PRODUCT_FAULT", label: "Will not power on" },
  BATTERY_ISSUE: { category: "PRODUCT_FAULT", label: "Battery problem" },
  SCREEN_OR_TOUCH: { category: "PRODUCT_FAULT", label: "Screen or touch problem" },
  CAMERA_ISSUE: { category: "PRODUCT_FAULT", label: "Camera problem" },
  NETWORK_OR_SIM: { category: "PRODUCT_FAULT", label: "Network or SIM problem" },
  OVERHEATING: { category: "PRODUCT_FAULT", label: "Overheating" },
  ACTIVATION_LOCKED: { category: "PRODUCT_FAULT", label: "Arrived Activation Locked" },
  PHYSICAL_DAMAGE_ON_ARRIVAL: { category: "PRODUCT_FAULT", label: "Damaged on arrival" },

  // Something went wrong getting it there.
  ARRIVED_LATE: { category: "LOGISTICS", label: "Arrived late" },
  ARRIVED_DAMAGED_BOX: { category: "LOGISTICS", label: "Box arrived damaged" },
  NEVER_ARRIVED: { category: "LOGISTICS", label: "Never arrived" },

  // Deliberately last, and deliberately awkward: it forces a written note and
  // cannot be given an attribution automatically. If OTHER climbs above roughly
  // one return in ten, a real reason is missing from this list.
  OTHER: { category: null, label: "Something else" },
};

const RETURN_REASON_CODES = Object.keys(RETURN_REASONS);

// Only a customer's own change of mind is the customer's cost.
const CUSTOMER_FAULT_CATEGORIES = [RETURN_REASON_CATEGORIES.PREFERENCE];

// How long the customer has, counted from the start of the window.
//
// Thirty days for every reason. The earlier split — 14 days for a change of
// mind, 30 for a fault — made the shorter window depend on the customer
// correctly classifying their own problem, and put UpCell below the policy its
// customers compare it against.
const RETURN_WINDOW_DAYS = 30;

const isReturnReasonCode = (code) =>
  Object.prototype.hasOwnProperty.call(RETURN_REASONS, code);

const reasonCategory = (code) => (isReturnReasonCode(code) ? RETURN_REASONS[code].category : null);

// Days from the window start. The same for every reason now, kept as a
// function so callers do not have to know that.
const returnWindowDays = () => RETURN_WINDOW_DAYS;

// UPCELL, CUSTOMER, or null when it cannot be decided from the code alone.
//
// Reporting only. It no longer changes what anyone pays — returns are free
// either way — but a device returned as "will not power on" that powers on
// fine is re-attributed at inspection, and that is what a pattern of bad-faith
// returns looks like in the numbers.
//
// null is not a failure: it is OTHER, and it means a person has to read the
// note and say.
function faultAttributionFor(code) {
  const category = reasonCategory(code);
  if (!category) return null;
  return CUSTOMER_FAULT_CATEGORIES.includes(category) ? "CUSTOMER" : "UPCELL";
}

// Nobody pays to send a device back, in either direction. Kept as a function
// rather than deleted so the callers that ask read as a policy question with a
// settled answer, rather than as an assumption nobody wrote down.
const customerPaysInboundPostage = () => false;

// There is no restocking fee, under any reason.
const restockingFeeApplies = () => false;

// Everything the rest of the system needs about one reason, in one call.
function returnPolicyFor(code) {
  return {
    code,
    known: isReturnReasonCode(code),
    category: reasonCategory(code),
    windowDays: RETURN_WINDOW_DAYS,
    faultAttribution: faultAttributionFor(code),
    // Both false for every reason now. Still returned so the form can say so
    // out loud rather than the customer having to infer it from silence.
    customerPaysPostage: false,
    restockingFee: false,
    // OTHER is the only code that cannot stand on its own.
    requiresNote: code === "OTHER",
  };
}

module.exports = {
  RETURN_REASONS,
  RETURN_REASON_CODES,
  RETURN_REASON_CATEGORIES,
  RETURN_WINDOW_DAYS,
  DEFAULT_RETURN_WINDOW_DAYS: RETURN_WINDOW_DAYS,
  isReturnReasonCode,
  reasonCategory,
  returnWindowDays,
  faultAttributionFor,
  customerPaysInboundPostage,
  restockingFeeApplies,
  returnPolicyFor,
};
