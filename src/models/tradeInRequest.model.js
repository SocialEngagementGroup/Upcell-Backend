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

const TradeInRequest = models?.TradeInRequest || model("TradeInRequest", TradeInRequestSchema);

module.exports = {
  TradeInRequest,
  tradeInStatusEnum,
  LEGACY_STATUSES,
};
