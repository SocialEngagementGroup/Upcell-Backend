// The states a trade-in moves through, and which moves are legal.
//
// Deliberately the same shape as returnStatus.js, because it is the same
// journey run backwards: a device travels to UpCell, somebody looks at it, and
// money moves. Everything the returns system learned the hard way — that a
// carrier saying "delivered" is not a person holding a phone, that Activation
// Lock has to park a device somewhere rather than fail it, that an offer of
// less than the quote needs its own state — is true here too, and copying the
// map is cheaper than learning it again.
//
// One real difference. A return starts from an order UpCell already has, so
// the first state is a customer asking. A trade-in starts from a price UpCell
// offered, so the first state is a quote. There is nothing before Quoted.
//
// TitleCase, matching the six statuses already stored and the convention the
// rest of this project uses. The plan writes them the same way.

const TRADE_IN_STATUS = {
  // A price has been quoted from the price book. Nothing has moved.
  Quoted: "Quoted",
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
  // Activation Lock, above all. The payout clock stops here.
  ActionRequired: "ActionRequired",
  // Worse than described. Less than the quote has been offered and the
  // customer has five days to accept or decline.
  RevisedOffer: "RevisedOffer",
  // Inspection passed, or a revised offer was accepted. Money is owed.
  Approved: "Approved",
  // The money has been sent.
  Paid: "Paid",
  // Refused. The device goes back at UpCell's cost.
  Rejected: "Rejected",
  // A rejected device is on its way back to the customer.
  ReturnShipped: "ReturnShipped",
  // The quote ran out before the customer sent anything.
  Expired: "Expired",
  // The customer changed their mind.
  Cancelled: "Cancelled",
  // Finished. Nothing further will happen.
  Closed: "Closed",
};

const TRADE_IN_STATUSES = Object.values(TRADE_IN_STATUS);

// Which moves are legal, and nothing else is.
//
// A request cannot jump from Quoted to Paid: the device has to arrive and be
// looked at first, which is the entire point. Every pre-money state can reach
// Rejected, because staff can refuse on what turns up or on what they find.
//
// Delivered is not the same as DeviceReceived, for the reason the returns map
// gives: the carrier saying "delivered" is a claim about a doorstep, and a
// person confirming receipt is a claim about a device in a hand. Inspection
// follows the second.
const ALLOWED_TRANSITIONS = {
  Quoted: ["LabelIssued", "InTransit", "Rejected", "Cancelled", "Expired"],
  // Same rule as returns: something has to say the parcel is moving before
  // anybody can say it arrived. A request at LabelIssued has a label printed
  // and nothing more, and letting that jump to received is how a trade-in is
  // marked complete for a box on a customer's kitchen table.
  LabelIssued: ["InTransit", "Delivered", "Expired", "Cancelled", "Rejected"],
  InTransit: ["Delivered", "DeviceReceived", "Rejected"],
  Delivered: ["DeviceReceived", "Rejected"],
  DeviceReceived: ["InInspection", "Approved", "Rejected"],
  InInspection: ["Approved", "RevisedOffer", "ActionRequired", "Rejected"],
  ActionRequired: ["InInspection", "Rejected"],
  RevisedOffer: ["Approved", "Rejected"],
  Approved: ["Paid"],
  Paid: ["Closed"],
  Rejected: ["ReturnShipped", "Closed"],
  ReturnShipped: ["Closed"],
  Expired: ["Closed"],
  Cancelled: ["Closed"],
  Closed: [],
};

// The states in which a trade-in is still live.
//
// A rejected, expired or cancelled request is not: somebody whose quote
// lapsed must be able to ask for a new one rather than being told they
// already have a trade-in open.
const ACTIVE_STATUSES = [
  "Quoted",
  "LabelIssued",
  "InTransit",
  "Delivered",
  "DeviceReceived",
  "InInspection",
  "ActionRequired",
  "RevisedOffer",
  "Approved",
];

const TERMINAL_STATUSES = TRADE_IN_STATUSES.filter(
  (status) => ALLOWED_TRANSITIONS[status].length === 0
);

// The payout clock does not run while the request is waiting on the customer.
// A device sitting Activation Locked is not UpCell failing to pay.
const CLOCK_PAUSED_STATUSES = ["ActionRequired", "RevisedOffer"];

// What the six old statuses become.
//
// Written here rather than only in the migration script so the mapping is
// readable next to the states it maps onto, and so a test can check it covers
// every old value.
//
// The awkward one is the old "Quoted", which meant two different things: a
// price offered before the device arrived, and a price revised after somebody
// looked at it. The migration cannot tell them apart from the status alone —
// it decides from whether the device was ever received. See
// scripts/migrate-trade-in-status.js.
const LEGACY_STATUS_MAP = {
  New: "Quoted",
  // "Contacted" recorded that somebody had emailed, which is not a state of
  // the device. Everything in it is a quote nobody has acted on.
  Contacted: "Quoted",
  Received: "DeviceReceived",
  Quoted: "Quoted",
  Paid: "Paid",
  Closed: "Closed",
};

const isTradeInStatus = (status) =>
  Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, status);

const canTransition = (from, to) =>
  isTradeInStatus(from) && (ALLOWED_TRANSITIONS[from] || []).includes(to);

/**
 * Why a move was refused, in words a staff member can act on.
 */
function transitionError(from, to) {
  if (!isTradeInStatus(from)) return `"${from}" is not a trade-in status.`;
  if (!isTradeInStatus(to)) return `"${to}" is not a trade-in status.`;

  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.length) return `A trade-in at ${from} is finished and cannot be moved.`;

  return `A trade-in at ${from} cannot go to ${to}. It can go to: ${allowed.join(", ")}.`;
}

module.exports = {
  TRADE_IN_STATUS,
  TRADE_IN_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  CLOCK_PAUSED_STATUSES,
  LEGACY_STATUS_MAP,
  isTradeInStatus,
  canTransition,
  transitionError,
};
