const { Schema, model, models } = require("mongoose");

// One signed-in customer's cart, so it survives the browser it was filled in.
//
// Stored as a flat list of variation ids rather than the {variationId, qty}
// the plan sketched. Every catalogue row is one physical device, so "quantity
// 2" of a variation cannot be bought — there is only one of it. The browser
// has always held a plain array of ids, and storing anything else would mean
// translating in both directions for a distinction this shop does not have.
//
// Duplicates are still allowed, because an accessory row can legitimately
// appear twice and the frontend removes by position.

const CartSchema = new Schema(
  {
    // The Clerk id, so this follows the account rather than the device. A
    // guest's cart stays in their own browser, which is the right place for
    // it — there is no account to attach it to.
    userId: { type: String, required: true, unique: true },

    items: [{ type: Schema.Types.ObjectId, ref: "SingleVariation" }],
  },
  { timestamps: true }
);

const Cart = models?.Cart || model("Cart", CartSchema);

module.exports = Cart;
