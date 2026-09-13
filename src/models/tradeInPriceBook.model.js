const { Schema, model, models } = require("mongoose");

// What UpCell pays for one model of device, before condition.
//
// One document per model, edited by staff rather than by a developer. The
// numbers came out of the trade-in page's own tables, where they were
// unreachable to anybody who could not deploy — which is the other half of why
// the pricing moved to the server. Yasir's real prices replace these through
// the admin screen, not through a release.

const TradeInPriceBookSchema = new Schema(
  {
    // The id the page sends: "iphone16promax", "mbp14m3". Kept as it was on
    // the frontend so a bookmarked quote link still resolves.
    modelKey: { type: String, required: true, unique: true },

    brand: String,
    // Decides which question set applies.
    deviceType: {
      type: String,
      enum: ["iPhone", "iPad", "MacBook", "Samsung", "Google"],
      required: true,
    },
    displayName: { type: String, required: true },

    // Cents, like every other money field on this project.
    basePriceCents: { type: Number, required: true, min: 0 },

    // { "128GB": 1.0, "256GB": 1.12, ... } — a size absent from the map is
    // quoted at the base price rather than refused.
    storageMultipliers: { type: Schema.Types.Mixed, default: {} },

    // { "unlocked": 1.0, "att": 1.0, ... }. Every value is 1.0 today: the
    // browser never used carrier in its arithmetic and this migration must
    // not change anybody's number. The field is here so a locked handset can
    // be worth less later without a code change.
    carrierAdjustments: { type: Schema.Types.Mixed, default: {} },

    // Taken off the list without deleting the row, so an old quote can still
    // be explained.
    active: { type: Boolean, default: true },

    // Bumped on every write. Stored on each request beside its breakdown, so a
    // quote disputed in November can be checked against the prices that were
    // live in September rather than against today's.
    priceBookVersion: { type: Number, default: 1 },

    updatedBy: String,
  },
  { timestamps: true }
);

TradeInPriceBookSchema.index({ deviceType: 1, active: 1 });

const TradeInPriceBook =
  models?.TradeInPriceBook || model("TradeInPriceBook", TradeInPriceBookSchema);

module.exports = TradeInPriceBook;
