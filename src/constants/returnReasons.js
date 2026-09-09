// Why a customer is sending a device back.
//
// The code the customer picks decides three things on its own, with no staff
// judgement and no second question on the form:
//
//   category          which return window applies (14 days or 30)
//   faultAttribution  who pays the postage back
//   restocking fee    charged, or not
//
// That is the whole point of grouping them. Before this, the reason was free
// text and the 15% fee was charged on every return unless a staff member
// remembered to waive it — so a customer returning a phone that would not power
// on was charged 15% for the privilege unless someone caught it by hand.
//
// UPCELL means the return is UpCell's doing: wrong item, faulty device, damaged
// in transit. CUSTOMER means the customer simply changed their mind. Only the
// second pays postage, and only the second pays a fee.

const RETURN_REASON_CATEGORIES = {
  PREFERENCE: "PREFERENCE",
  FULFILMENT: "FULFILMENT",
  PRODUCT_FAULT: "PRODUCT_FAULT",
  LOGISTICS: "LOGISTICS",
};

// Every code, with the category it belongs to and the words a customer sees.
// Adding a code here is all that is needed — window, postage and fee follow
// from the category without another edit anywhere.
const RETURN_REASONS = {
  // The customer changed their mind. Their choice, so their postage and the fee.
  CHANGED_MIND: { category: "PREFERENCE", label: "Changed my mind" },
  FOUND_BETTER_PRICE: { category: "PREFERENCE", label: "Found a better price" },
  NO_LONGER_NEEDED: { category: "PREFERENCE", label: "No longer needed" },

  // UpCell sent the wrong thing.
  WRONG_MODEL: { category: "FULFILMENT", label: "Wrong model sent" },
  WRONG_STORAGE: { category: "FULFILMENT", label: "Wrong storage size sent" },
  WRONG_COLOR: { category: "FULFILMENT", label: "Wrong colour sent" },
  MISSING_ITEMS: { category: "FULFILMENT", label: "Items missing from the box" },
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

// How long the customer has, counted from delivery.
//
// A device that is broken or wrong is UpCell's problem for longer than one the
// customer simply decided against — 30 days against 14. OTHER gets the longer
// window on purpose: it is the code used when the list did not fit, and cutting
// someone off early over a wording gap is the wrong way to be wrong.
const RETURN_WINDOW_DAYS = {
  PREFERENCE: 14,
  FULFILMENT: 30,
  PRODUCT_FAULT: 30,
  LOGISTICS: 30,
};

const DEFAULT_RETURN_WINDOW_DAYS = 30;

const isReturnReasonCode = (code) =>
  Object.prototype.hasOwnProperty.call(RETURN_REASONS, code);

const reasonCategory = (code) => (isReturnReasonCode(code) ? RETURN_REASONS[code].category : null);

// Days from delivery for this reason. An unknown or absent code gets the longer
// window rather than the shorter one, for the same reason OTHER does.
function returnWindowDays(code) {
  const category = reasonCategory(code);
  return RETURN_WINDOW_DAYS[category] || DEFAULT_RETURN_WINDOW_DAYS;
}

// UPCELL, CUSTOMER, or null when it cannot be decided from the code alone.
//
// null is not a failure — it is OTHER, and it means a staff member has to read
// the note and say. Returning a guess here would be worse than returning
// nothing, because the guess silently decides who pays.
function faultAttributionFor(code) {
  const category = reasonCategory(code);
  if (!category) return null;
  return CUSTOMER_FAULT_CATEGORIES.includes(category) ? "CUSTOMER" : "UPCELL";
}

// Whether the customer pays to send it back. Same rule as the fee, kept as its
// own function because they are separate policies that happen to agree today.
const customerPaysInboundPostage = (code) => faultAttributionFor(code) === "CUSTOMER";

// Whether the 15% restocking fee applies.
//
// Change of mind only. A faulty, wrong, or damaged device is never charged it —
// that was the live bug this replaces. OTHER returns false: with attribution
// undecided, the safe default is not to take money off the customer, and staff
// can still apply the fee by hand once they have read the note.
const restockingFeeApplies = (code) => reasonCategory(code) === RETURN_REASON_CATEGORIES.PREFERENCE;

// Everything the rest of the system needs about one reason, in one call.
function returnPolicyFor(code) {
  return {
    code,
    known: isReturnReasonCode(code),
    category: reasonCategory(code),
    windowDays: returnWindowDays(code),
    faultAttribution: faultAttributionFor(code),
    customerPaysPostage: customerPaysInboundPostage(code),
    restockingFee: restockingFeeApplies(code),
    // OTHER is the only code that cannot stand on its own.
    requiresNote: code === "OTHER",
  };
}

module.exports = {
  RETURN_REASONS,
  RETURN_REASON_CODES,
  RETURN_REASON_CATEGORIES,
  RETURN_WINDOW_DAYS,
  DEFAULT_RETURN_WINDOW_DAYS,
  isReturnReasonCode,
  reasonCategory,
  returnWindowDays,
  faultAttributionFor,
  customerPaysInboundPostage,
  restockingFeeApplies,
  returnPolicyFor,
};
