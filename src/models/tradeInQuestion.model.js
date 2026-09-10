const { Schema, model, models } = require("mongoose");

// The condition questions for one kind of device, and what each answer does
// to the price.
//
// Separate from the price book because they change for different reasons: a
// price moves with the market, a question changes when UpCell decides what it
// cares about. One document per device type, in the order they are asked.

const OptionSchema = new Schema(
  {
    _id: false,
    id: { type: String, required: true },
    title: { type: String, required: true },
    desc: String,
    // 1.0 means this answer costs nothing. The best option in every set is
    // 1.0, which is what makes the base price mean "a good one of these".
    multiplier: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false }
);

const TradeInQuestionSchema = new Schema(
  {
    deviceType: {
      type: String,
      enum: ["iPhone", "iPad", "MacBook", "Samsung", "Google"],
      required: true,
      unique: true,
    },
    questions: [
      {
        _id: false,
        id: { type: String, required: true },
        question: { type: String, required: true },
        subtitle: String,
        type: { type: String, enum: ["boolean", "choice"], required: true },
        options: [OptionSchema],
        // What a "no" costs. Only meaningful for a boolean.
        noMultiplier: Number,
        // A "no" here ends the quote. Set on powersOn: every question after it
        // asks about something nobody can check on a device that will not
        // switch on.
        terminal: { type: Boolean, default: false },
      },
    ],
    priceBookVersion: { type: Number, default: 1 },
    updatedBy: String,
  },
  { timestamps: true }
);

const TradeInQuestion =
  models?.TradeInQuestion || model("TradeInQuestion", TradeInQuestionSchema);

module.exports = TradeInQuestion;
