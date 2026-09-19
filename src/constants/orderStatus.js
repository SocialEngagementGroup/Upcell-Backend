// The order state machine.
//
// Returns and trade-ins have had one since they were built (see
// returnStatus.js and tradeInStatus.js); orders never did. Only the status
// *value* was checked, so the admin screen accepted Delivered -> Processing,
// Refunded -> Shipped, and every other move that cannot have happened. A
// status reached once stays reached, and the return window, the refund path
// and the customer's order list all read it.
//
// Deliberately its own module rather than a property hung off order.model.js.
// Several suites call jest.mock("../src/models/order.model"), which replaces
// every export with a stub — so a guard living on the model returns undefined
// under test and refuses every transition. A guard that quietly stops working
// wherever the model is mocked is worse than no guard, because it reads as
// though something is watching.

const ORDER_STATUSES = [
  "pending_payment",
  "under_review",
  "Processing",
  "Shipped",
  "Delivered",
  "Returned",
  "Refunded",
  "payment failed",
];

// Two back-steps are legal on purpose, because they are corrections rather
// than state violations and staff make them:
//
//   Delivered -> Shipped    a delivery ticked by mistake. updateOrderStatus
//                           already anticipates exactly this — deliveredAt is
//                           stamped once and left alone, so going back and
//                           forward cannot hand the customer a fresh 30 days.
//   Returned  -> Delivered  the same, for a return logged against the wrong
//                           order.
//
// What is not legal is jumping the payment. pending_payment -> Shipped means
// posting a device for an order with no payment behind it; going through
// Processing is what marks it paid, and that is a step worth taking rather
// than skipping.
//
// Refunded and "payment failed" are terminal. Money has moved, or it never
// will; either way the next step is a new record, not an edit to this one.
const ALLOWED_ORDER_TRANSITIONS = {
  pending_payment: ["under_review", "Processing", "payment failed"],
  under_review: ["Processing", "payment failed"],
  // Refundable before dispatch: a customer who cancels gets their money back
  // without anything having been posted.
  Processing: ["Shipped", "Refunded"],
  Shipped: ["Delivered", "Returned"],
  Delivered: ["Shipped", "Returned", "Refunded"],
  Returned: ["Delivered", "Refunded"],
  Refunded: [],
  "payment failed": [],
};

const isOrderStatus = (value) => ORDER_STATUSES.includes(value);

// Setting a status to what it already is is not a move. It is a repeated click
// or a double submit, and answering 400 to that would be a worse experience
// than the missing guard was.
const canTransitionOrder = (from, to) =>
  from === to || (ALLOWED_ORDER_TRANSITIONS[from] || []).includes(to);

// Names what would have been legal, because the person reading it is looking
// at a dropdown that offered the option.
const orderTransitionError = (from, to) => {
  const allowed = ALLOWED_ORDER_TRANSITIONS[from] || [];
  if (!allowed.length) {
    return `An order that is ${from} is finished, and cannot become ${to}.`;
  }
  return `An order cannot go from ${from} to ${to}. It can only become: ${allowed.join(", ")}.`;
};

// This governs the ADMIN path only. The bank gateway writes status through
// findOneAndUpdate in bankOfAmerica.controller.js and is not routed through
// here — a confirmation arriving from the bank must never be refused by a rule
// written for a dropdown.
module.exports = {
  ORDER_STATUSES,
  ALLOWED_ORDER_TRANSITIONS,
  isOrderStatus,
  canTransitionOrder,
  orderTransitionError,
};
