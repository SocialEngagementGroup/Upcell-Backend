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
    estimate: { type: Number, required: true },
    answers: { type: Schema.Types.Mixed, default: {} },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    status: { type: String, enum: tradeInStatusEnum, default: "New" },
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
