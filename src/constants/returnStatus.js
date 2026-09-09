// The states a return moves through, and which moves are legal.
//
// Kept in TitleCase, matching the six statuses already stored in the database
// and the convention the rest of this project uses for status values. The
// returns plan writes them in snake_case; renaming them would mean migrating
// every existing request and every stored timeline entry to gain nothing a
// customer or a staff member can see. src/constants/orderStatus.js on the
// frontend carries the same note about why order statuses were never renamed.
//
// The six original states are unchanged and keep their meaning. The rest fill
// in the parts of the journey that were previously invisible: the device in the
// post, the inspection itself, an offer of less than the full amount, and the
// blocked case where a device arrives that nobody can do anything with.

const RETURN_STATUS = {
  // The customer has asked. Nobody has looked yet.
  Submitted: "Submitted",
  // Staff agreed. The return is authorised but nothing has shipped.
  ReturnApproved: "ReturnApproved",
  // A label exists and has been sent to the customer.
  LabelIssued: "LabelIssued",
  // The carrier has it.
  InTransit: "InTransit",
  // The carrier says it arrived. Not the same as UpCell having it in hand.
  Delivered: "Delivered",
  // A person has physically confirmed possession.
  DeviceReceived: "DeviceReceived",
  // Being looked at right now, by a named inspector.
  InInspection: "InInspection",
  // Something is blocking inspection that only the customer can clear —
  // Activation Lock, above all. The settlement clock stops here.
  ActionRequired: "ActionRequired",
  // Worse than described. Less than the full amount has been offered and the
  // customer has five days to accept or decline.
  RevisedOffer: "RevisedOffer",
  // Inspection passed, or a revised offer was accepted. Money is owed.
  Approved: "Approved",
  // The money has been handed over or transferred.
  Refunded: "Refunded",
  // Refused. The device goes back at UpCell's cost.
  Rejected: "Rejected",
  // A rejected device is on its way back to the customer.
  ReturnShipped: "ReturnShipped",
  // The authorisation ran out before the customer sent anything.
  Expired: "Expired",
  // The customer changed their mind about returning.
  Cancelled: "Cancelled",
  // Finished. Nothing further will happen.
  Closed: "Closed",
};

const RETURN_STATUSES = Object.values(RETURN_STATUS);

// Which moves are legal, and nothing else is.
//
// A request cannot jump from Submitted to Approved: the device has to come back
// and be looked at first, which is the entire point of the workflow. Every
// pre-money state can reach Rejected, because staff can refuse on the request,
// on what turns up, or on what they find.
//
// Delivered is deliberately not the same as DeviceReceived. The carrier saying
// "delivered" is a claim about a doorstep; a person confirming receipt is a
// claim about a device in a hand. Inspection follows the second, never the
// first.
const ALLOWED_TRANSITIONS = {
  Submitted: ["ReturnApproved", "Rejected", "Cancelled", "Expired"],
  ReturnApproved: ["LabelIssued", "DeviceReceived", "Rejected", "Cancelled", "Expired"],
  // DeviceReceived stays reachable directly: a customer can walk a device in,
  // and a return posted before labels existed has no carrier events at all.
  LabelIssued: ["InTransit", "Delivered", "DeviceReceived", "Expired", "Cancelled", "Rejected"],
  InTransit: ["Delivered", "DeviceReceived", "Rejected"],
  Delivered: ["DeviceReceived", "Rejected"],
  DeviceReceived: ["InInspection", "Approved", "Rejected"],
  InInspection: ["Approved", "RevisedOffer", "ActionRequired", "Rejected"],
  ActionRequired: ["InInspection", "Rejected"],
  RevisedOffer: ["Approved", "Rejected"],
  Approved: ["Refunded"],
  Refunded: ["Closed"],
  Rejected: ["ReturnShipped", "Closed"],
  ReturnShipped: ["Closed"],
  Expired: ["Closed"],
  Cancelled: ["Closed"],
  Closed: [],
};

// The states in which a request still occupies its order.
//
// A rejected, expired or cancelled request does not: a customer refused over a
// mistake on the form, or who let the authorisation lapse, must be able to
// submit a corrected one. Only these block a second request against the same
// order line.
const ACTIVE_STATUSES = [
  "Submitted",
  "ReturnApproved",
  "LabelIssued",
  "InTransit",
  "Delivered",
  "DeviceReceived",
  "InInspection",
  "ActionRequired",
  "RevisedOffer",
  "Approved",
];

// Nothing further happens from here.
const TERMINAL_STATUSES = RETURN_STATUSES.filter(
  (status) => ALLOWED_TRANSITIONS[status].length === 0
);

// The settlement clock does not run while the request is waiting on the
// customer. UpCell promised two business days from the end of inspection, and
// a device sitting Activation Locked is not UpCell failing to act.
const CLOCK_PAUSED_STATUSES = ["ActionRequired", "RevisedOffer"];

// Photos are kept indefinitely once a return has gone wrong, because these are
// the cases that turn into a dispute months later. The purge job reads this.
const PHOTO_HOLD_STATUSES = ["Rejected", "ReturnShipped", "RevisedOffer"];

const isReturnStatus = (status) =>
  Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, status);

// Whether a move is allowed. A status that does not exist is not a legal
// destination from anywhere, which is what stops a typo becoming a state.
function canTransition(from, to) {
  if (!isReturnStatus(from) || !isReturnStatus(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// The same check, phrased for a caller that wants to explain the refusal.
// Returns null when the move is fine, and a sentence when it is not.
function transitionError(from, to) {
  if (!isReturnStatus(from)) return `"${from}" is not a return status.`;
  if (!isReturnStatus(to)) return `"${to}" is not a return status.`;
  if (from === to) return `This return is already ${from}.`;
  if (!canTransition(from, to)) {
    const allowed = ALLOWED_TRANSITIONS[from];
    return allowed.length
      ? `A return that is ${from} can only move to: ${allowed.join(", ")}.`
      : `A return that is ${from} is finished and cannot change.`;
  }
  return null;
}

module.exports = {
  RETURN_STATUS,
  RETURN_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  CLOCK_PAUSED_STATUSES,
  PHOTO_HOLD_STATUSES,
  isReturnStatus,
  canTransition,
  transitionError,
};
