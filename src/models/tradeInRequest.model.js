const { Schema, model, models } = require("mongoose");

const tradeInStatusEnum = [
  "New",
  "Contacted",
  "Received",
  "Quoted",
  "Paid",
  "Closed",
];

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
    status: { type: String, enum: tradeInStatusEnum, default: "New" },
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
};
