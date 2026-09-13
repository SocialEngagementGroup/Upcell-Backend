const { Schema, model, models } = require("mongoose");
const { TRADE_IN_STATUSES } = require("../constants/tradeInStatus");

// The old six. Kept in the enum so a document written before the state
// machine existed still loads — Mongoose refuses to hydrate a document whose
// stored value is not in the enum, and a validation error on read would take
// the admin queue down rather than showing an out-of-date status.
//
// scripts/migrate-trade-in-status.js converts them. Once it has run against
// production and nothing is left on an old value, these six can go.
const LEGACY_STATUSES = ["New", "Contacted", "Received"];

const tradeInStatusEnum = [...new Set([...TRADE_IN_STATUSES, ...LEGACY_STATUSES])];

const TradeInRequestSchema = new Schema(
  {
    device: { type: String, required: true },
    model: { type: String, required: true },
    modelTitle: { type: String, required: true },
    carrier: String,
    carrierTitle: String,
    storage: { type: String, required: true },
    // What UpCell will pay, computed on the server. Required, and no longer
    // taken from the request body — see createTradeInRequest.
    estimate: { type: Number, required: true },
    estimateCents: Number,

    // What the browser said it should be. Kept only so a disagreement is
    // visible: a stored value that never matches this one means the page and
    // the engine have drifted, and a wild one means somebody edited the
    // request before sending it.
    clientEstimateCents: Number,

    // The arithmetic, step by step. A quote disputed in November is answered
    // from this rather than by rerunning today's prices over it.
    quoteBreakdown: [
      {
        _id: false,
        step: String,
        multiplier: Number,
        resultCents: Number,
      },
    ],
    priceBookVersion: Number,

    // Fourteen days. A quote is a price for a device in a condition the
    // customer described weeks ago, and the market moves.
    quoteExpiresAt: Date,
    answers: { type: Schema.Types.Mixed, default: {} },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    // A trade-in starts at a price UpCell offered, not at a customer asking:
    // there is nothing before Quoted. See constants/tradeInStatus.js.
    status: { type: String, enum: tradeInStatusEnum, default: "Quoted", index: true },

    // The append-only record of everything that happened to this request.
    //
    // The same shape as a return's, and for the same reason: "the customer
    // says they posted it, we say it never arrived" is only answerable from a
    // log nobody can edit. Entries are pushed and never updated.
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
    // The parcels, in both directions.
    //
    // Exactly the shape refundRequest.model.js uses, because services/
    // returnShipping.js reads these paths and writing a second shape would
    // mean a second copy of that code. Inbound is the customer's device coming
    // to UpCell; outbound is a refused one going back.
    shipping: {
      inbound: {
        carrier: String,
        trackingNumber: String,
        labelUrl: String,
        labelCost: Number,
        // Always UPCELL on a trade-in. UpCell wants the device, so UpCell pays
        // to get it — unlike a return, where a change of mind is the
        // customer's own cost.
        paidBy: String,
        shippedAt: Date,
        deliveredAt: Date,
      },
      outbound: {
        carrier: String,
        trackingNumber: String,
        labelUrl: String,
        labelCost: Number,
        paidBy: String,
        shippedAt: Date,
        undeliverableAt: Date,
        undeliverableReason: String,
        disposeAfter: Date,
      },
    },

    // What the device actually turned out to be.
    //
    // The same checklist a return is inspected against, with one difference in
    // meaning rather than in shape: `imei_matches` on a return asks whether the
    // device sent back is the device that was sold. There is no prior record
    // for a trade-in, so here it records the number for the first time.
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
      // Recorded because the next buyer needs it, and because the quote was
      // priced on what the customer said it was.
      batteryHealth: Number,
      cosmeticGrade: String,
      // The lower of the battery band and the cosmetic grade.
      finalGrade: String,
      imei: String,
      serialNumber: String,
      photos: [
        {
          _id: false,
          url: String,
          publicId: String,
          caption: String,
          takenAt: Date,
          purgeAfter: Date,
        },
      ],
      findings: String,
    },

    // What is being offered after inspection, when it is less than the quote.
    //
    // Stored in cents alongside the deductions that produced it. A customer who
    // disputes an offer in November is answered from these lines, not by
    // rerunning today's inspection rules over it.
    revisedOfferCents: Number,
    offerDeductions: [
      {
        _id: false,
        type: String,
        amount: Number,
        reason: String,
        findingKey: String,
      },
    ],
    offerExpiresAt: Date,

    // The unguessable half of a link the customer can open without signing in,
    // to accept or decline a revised offer. Hashed — see utils/accessToken.js.
    // Not a session: it grants exactly this trade-in and never confers admin.
    accessToken: { type: String, select: false },

    // Two business days from the end of inspection, paused while the request is
    // waiting on the customer rather than on UpCell.
    sla: {
      clockStartedAt: Date,
      clockPausedAt: Date,
      dueAt: Date,
      breached: { type: Boolean, default: false },
    },

    // The catalogue row created from this device once the trade-in is agreed,
    // so the two can be traced to each other. A device UpCell bought and a
    // device UpCell sells are the same physical phone, and a fault reported
    // later has to be answerable from both ends.
    listedVariationId: { type: Schema.Types.ObjectId, ref: "SingleVariation" },

    // Set by hand when a customer disputes an offer, by any route. Freezes the
    // inspection photos past their 90 days, because the moment they matter
    // most is the moment somebody is arguing about what arrived.
    disputed: { type: Boolean, default: false },

    // How the money went out.
    //
    // UpCell does not hold bank details and must not start now. Everything
    // here is either chosen from a list or already public to the customer:
    // the method, the name on the account, and a masked reference — the last
    // four digits of an account, or a Zelle handle, which is an email or a
    // phone number the customer already gave.
    //
    // The full detail is read off the customer's own accept step at the
    // moment of paying and never stored. A trade-in record that carries a
    // complete account number is a record that has to be protected like a
    // payment system, and this is a phone shop.
    payout: {
      method: { type: String, enum: ["BANK_TRANSFER", "ZELLE", "CHECK", null], default: null },
      recipientName: { type: String, trim: true },
      // "•••• 4417" or "sam@example.com". Enough to tell two accounts apart
      // and to answer "where did my money go", and nothing more.
      referenceMasked: { type: String, trim: true },
      amountCents: Number,
      paidAt: Date,
      paidBy: String,
      // UpCell's own reference for the transfer — a bank confirmation number
      // or a cheque number. Theirs, not the customer's.
      reference: { type: String, trim: true },
    },

    emailStatus: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      default: "pending",
    },
    emailThreadId: String,
  },
  { timestamps: true }
);

TradeInRequestSchema.index({ status: 1, updatedAt: -1 });
TradeInRequestSchema.index({ email: 1, updatedAt: -1 });
// The receiving desk's lookup: somebody types a tracking number off a box and
// has to get one answer. Sparse because most requests never get a label.
TradeInRequestSchema.index({ "shipping.inbound.trackingNumber": 1 }, { sparse: true });
TradeInRequestSchema.index({ "shipping.outbound.trackingNumber": 1 }, { sparse: true });
// And by the number on the device itself, for a box that arrived with no label
// or a label nobody can read.
TradeInRequestSchema.index({ "inspection.imei": 1 }, { sparse: true });

const TradeInRequest = models?.TradeInRequest || model("TradeInRequest", TradeInRequestSchema);

module.exports = {
  TradeInRequest,
  tradeInStatusEnum,
  LEGACY_STATUSES,
};
