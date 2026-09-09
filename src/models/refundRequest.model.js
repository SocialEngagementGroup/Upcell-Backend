const { Schema, model, models } = require("mongoose");
const {
  RETURN_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
} = require("../constants/returnStatus");
const { RETURN_REASON_CODES } = require("../constants/returnReasons");

// A refund is not one action, it is a physical process: the customer asks, the
// device travels back, someone looks at it, and only then does money move. This
// model is the record of that process. The money itself still lives on
// order.refund, written by the existing processRefund - this tracks everything
// that has to happen before that is allowed to run.
//
// The statuses and the map of legal moves between them live in
// src/constants/returnStatus.js, shared with the controller and the admin UI so
// there is one list rather than three that drift apart.

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

    status: { type: String, enum: RETURN_STATUSES, default: "Submitted", index: true },

    // "RMA-2026-00412" - what the customer writes on the box and quotes in an
    // email. Assigned when staff approve, not at submission: a request nobody
    // has agreed to yet has nothing to authorise.
    rmaNumber: { type: String, trim: true, uppercase: true },

    // The structured reason, alongside the customer's own words in `reason`.
    // The code decides the return window, who pays postage and whether the
    // restocking fee applies - see src/constants/returnReasons.js. Optional so
    // that requests created before reason codes existed still load.
    reasonCode: { type: String, default: null },
    reasonCategory: { type: String, default: null },
    // UPCELL or CUSTOMER. Derived from the category at submission, but stored
    // rather than computed on read, because inspection can overturn it: a
    // device returned as "will not power on" that powers on fine is no longer
    // UpCell's fault, and that change is what triggers a revised offer.
    faultAttribution: { type: String, enum: ["UPCELL", "CUSTOMER", null], default: null },

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

    // What was actually sent back, captured at inspection. The IMEI is the only
    // thing tying a device on a bench to a line on an order.
    device: {
      model: String,
      storage: String,
      color: String,
      imei: String,
      serial: String,
      imeiVerified: { type: Boolean, default: false },
    },

    // The money, itemised.
    //
    // Every one of these is written by the server from the order and the
    // inspection findings. None is ever accepted from the browser - a posted
    // refund amount is a posted price, and the trade-in `estimate` field is
    // already an open bug of exactly that shape.
    refundBreakdown: {
      orderAmount: Number,
      deductions: [
        {
          _id: false,
          // RESTOCKING_FEE | INBOUND_POSTAGE | DAMAGE
          type: String,
          amount: Number,
          // Why. A deduction with no reason is the thing customers dispute.
          reason: String,
        },
      ],
      offeredAmount: Number,
      offerExpiresAt: Date,
      finalAmount: Number,
    },

    // The authorisation itself: when it was issued and when it lapses.
    rma: {
      issuedAt: Date,
      expiresAt: Date,
      // Which reminders have already gone out, so a re-run of the daily job
      // does not send day 7 twice.
      remindersSent: { type: [Number], default: [] },
    },

    shipping: {
      // The device coming back to UpCell.
      inbound: {
        carrier: String,
        trackingNumber: String,
        labelUrl: String,
        labelCost: Number,
        // UPCELL or CUSTOMER - follows faultAttribution.
        paidBy: String,
        shippedAt: Date,
        deliveredAt: Date,
      },
      // A rejected device going back to the customer. UpCell pays this on a
      // customer's first rejection; a repeat is flagged for staff, never
      // blocked by the system.
      outbound: {
        carrier: String,
        trackingNumber: String,
        labelUrl: String,
        labelCost: Number,
        paidBy: String,
        paidAt: Date,
        shippedAt: Date,
      },
    },

    // The structured inspection. `inspectionNotes` above is still the
    // inspector's prose; this is the part that can be reported on.
    inspection: {
      inspectorId: String,
      startedAt: Date,
      completedAt: Date,
      checklist: [
        {
          _id: false,
          key: String,
          // pass | fail | na
          result: String,
          note: String,
        },
      ],
      // A | B | C | FAIL
      grade: String,
      photos: [
        {
          _id: false,
          url: String,
          // The Cloudinary handle. Without it a photo cannot be deleted, so the
          // 90-day purge would have nothing to act on.
          publicId: String,
          caption: String,
          takenAt: Date,
          purgeAfter: Date,
        },
      ],
      findings: String,
    },

    // Two business days from the end of inspection, paused while the request is
    // waiting on the customer rather than on UpCell.
    sla: {
      clockStartedAt: Date,
      clockPausedAt: Date,
      dueAt: Date,
      breached: { type: Boolean, default: false },
    },

    resolution: {
      // FULL_REFUND | PARTIAL_ACCEPTED | PARTIAL_DECLINED | REJECTED | EXPIRED | CANCELLED
      outcome: String,
      // CASH | BANK_TRANSFER | ORIGINAL_PAYMENT - defaults to however the order
      // was paid, because refunding by a different route is how money goes
      // missing.
      settlementMethod: String,
      settlementAmount: Number,
      // A bank reference, or the id of a signed receipt for a cash handover.
      settlementRef: String,
      // Required when the method is CASH. Without it there is no record of who
      // was paid, by which of the two or three staff.
      receiptUrl: String,
      settledAt: Date,
      settledBy: String,
    },

    // Where the device went afterwards. Required before a request can close, so
    // that an accepted device cannot quietly become a device on a shelf.
    disposition: {
      // RESTOCK_NEW | OPEN_BOX | RETURN_TO_SUPPLIER | WHOLESALE | SCRAP
      type: String,
      grade: String,
      inventoryItemId: String,
      decidedBy: String,
      decidedAt: Date,
    },

    // The unguessable half of a link the customer can open without signing in:
    // the one-click accept/decline on a revised offer, and the tracking page.
    // Not a session — it grants exactly this return and never confers admin.
    // See src/utils/accessToken.js.
    accessToken: { type: String, select: false },

    // Append-only. Never edited, never deleted.
    //
    // This is the dispute record. "The customer says they posted it, we say it
    // never arrived" is only answerable from an immutable log - and with any of
    // the two or three staff able to approve, attribution is the only control
    // there is.
    timeline: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        // Clerk id, or "system" for a scheduled job.
        actor: String,
        // staff | customer | system
        actorType: String,
        event: String,
        from: String,
        to: String,
        meta: Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true }
);

// The RMA a customer quotes must find exactly one request. Sparse because a
// request only gets a number once staff approve it.
RefundRequestSchema.index({ rmaNumber: 1 }, { unique: true, sparse: true });
// The expiry job asks for authorisations issued and not yet shipped.
RefundRequestSchema.index({ "rma.expiresAt": 1 });
// A customer opening an emailed link is looked up by this and nothing else.
RefundRequestSchema.index({ accessToken: 1 }, { sparse: true });
// The job that auto-declines an unanswered offer after five days.
RefundRequestSchema.index({ "refundBreakdown.offerExpiresAt": 1 }, { sparse: true });

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
// Re-exported so the controller and its tests keep importing these from the
// model, as they did before the lists moved to src/constants/returnStatus.js.
module.exports.REFUND_REQUEST_STATUSES = RETURN_STATUSES;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
