const { Schema, model, models } = require("mongoose");

// What a customer thought of the phone they bought.
//
// Every review here is tied to an order that was delivered, which is what the
// "Verified purchase" badge means and the only reason it is worth anything. A
// shop selling used devices lives or dies on whether people believe the
// listings, and a review system anyone can post to is worth less than none —
// it moves the question from "is this phone any good" to "are these reviews
// real", which is harder to answer and worse to get wrong.
//
// So there is no anonymous route in. A review requires a signed-in customer,
// an order of theirs, that order delivered, and the device on it.

const ReviewSchema = new Schema(
  {
    // The product family, which is what the product page shows. A review of
    // one 128GB Midnight unit is a review of the iPhone 13 as far as the next
    // buyer is concerned.
    parentId: { type: Schema.Types.ObjectId, ref: "ParentProduct", required: true, index: true },
    // The exact unit they were sold, kept so a pattern in one batch can be
    // found later. Not shown to anybody.
    productId: { type: Schema.Types.ObjectId, required: true },

    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    userId: { type: String, required: true, index: true },
    // Shown next to the review. Taken from the account rather than typed, so a
    // reviewer cannot sign their review "UpCell Staff".
    displayName: { type: String, required: true, trim: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 80 },
    body: { type: String, trim: true, maxlength: 2000 },

    // Always true, because there is no way to create one that is not. Stored
    // rather than assumed so that if an unverified route is ever added, every
    // review already written still says which it was.
    verifiedPurchase: { type: Boolean, default: true },

    // Nothing appears on a product page until somebody has read it.
    //
    // PENDING rather than APPROVED by default, and deliberately so: the cost
    // of a slow review is a customer waiting a day, and the cost of an
    // automatic one is whatever somebody chose to type appearing under a
    // product UpCell sells.
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "HIDDEN"],
      default: "PENDING",
      index: true,
    },
    moderatedBy: String,
    moderatedAt: Date,
    // Why it was hidden. Not shown to the customer — it is the note the next
    // person to look at this needs.
    moderationNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// One review per item per order.
//
// A customer who bought two phones can review both; one who bought one phone
// gets one say in its rating. Enforced by the database rather than by a check
// in the controller, because two submissions a second apart would both pass
// the check and both be written.
ReviewSchema.index({ orderId: 1, productId: 1 }, { unique: true });

// The product page's own query: approved reviews for one family, newest first.
ReviewSchema.index({ parentId: 1, status: 1, createdAt: -1 });

const Review = models?.Review || model("Review", ReviewSchema);

module.exports = Review;
