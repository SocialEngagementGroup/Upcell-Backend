const { Schema, model, models } = require("mongoose");

// A refund is not one action, it is a physical process: the customer asks, the
// device travels back, someone looks at it, and only then does money move. This
// model is the record of that process. The money itself still lives on
// order.refund, written by the existing processRefund — this tracks everything
// that has to happen before that is allowed to run.
//
// Statuses, in the order they normally occur:
//
//   Submitted        customer asked, nobody has looked yet
//   ReturnApproved   staff agreed, return instructions sent
//   DeviceReceived   the phone is physically back
//   Approved         inspected and accepted, refund recorded on the order
//   Refunded         the amount has been entered at the bank
//   Rejected         refused — reachable from any of the first three
//
// Inspection is not a status of its own. It is the act of deciding between
// Approved and Rejected, so it is recorded as fields filled in at that moment
// rather than a state the request sits in.
const REFUND_REQUEST_STATUSES = [
  "Submitted",
  "ReturnApproved",
  "DeviceReceived",
  "Approved",
  "Refunded",
  "Rejected",
];

// Which moves are legal. A request cannot jump from Submitted straight to
// Approved — the device has to come back first, which is the whole point of the
// workflow. Rejected is reachable from any stage before a refund is recorded,
// because staff can refuse on the request itself, on what arrives, or on what
// they find when they look at it.
const ALLOWED_TRANSITIONS = {
  Submitted: ["ReturnApproved", "Rejected"],
  ReturnApproved: ["DeviceReceived", "Rejected"],
  DeviceReceived: ["Approved", "Rejected"],
  Approved: ["Refunded"],
  Refunded: [],
  Rejected: [],
};

// The states in which a request still occupies the order. A rejected request
// does not: a customer refused over a mistake on the form must be able to
// submit a corrected one, so only these block a new request.
const ACTIVE_STATUSES = ["Submitted", "ReturnApproved", "DeviceReceived", "Approved"];

const RefundRequestSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    // Copied from the order at creation rather than joined on read. The
    // customer's Clerk id is what proves ownership on every later request, and
    // email is what the notifications go to.
    userId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },

    // productIds of the line items the customer selected. Not the whole order:
    // someone returning one phone out of three names that one.
    itemIds: { type: [String], required: true },
    // Why they are returning it, in their words. Staff read this before
    // deciding whether the restocking fee should be waived.
    reason: { type: String, required: true, trim: true },

    status: { type: String, enum: REFUND_REQUEST_STATUSES, default: "Submitted" },

    // Free text, written by hand and emailed to the customer. Return address,
    // what to put in the box, anything else. Deliberately not structured for
    // now — shipping labels and tracking come later.
    returnInstructions: String,

    receivedAt: Date,
    receivedBy: String,

    // Filled at the moment of approving or rejecting. What the device looked
    // like when it arrived, in the inspector's words.
    inspectionNotes: String,
    inspectedBy: String,
    inspectedAt: Date,

    // Required by the controller whenever the status becomes Rejected, so a
    // refusal always carries something the customer can be told.
    rejectionReason: String,

    // What calculateRefund worked out at approval: items total minus the 15%
    // restocking fee. Kept here as well as on order.refund so the request shows
    // the figure without loading the order.
    calculatedAmount: Number,
  },
  { timestamps: true }
);

// The admin queue is "show me everything at this stage, newest first", which is
// the same shape as every other admin list in the project.
RefundRequestSchema.index({ status: 1, createdAt: -1 });
// A customer's own list.
RefundRequestSchema.index({ userId: 1, createdAt: -1 });
// One live request per order. Partial rather than plain unique: a rejected
// request must not lock the order out of ever being refunded.
RefundRequestSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } }
);

const RefundRequest =
  models?.RefundRequest || model("RefundRequest", RefundRequestSchema);

module.exports = RefundRequest;
module.exports.REFUND_REQUEST_STATUSES = REFUND_REQUEST_STATUSES;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
