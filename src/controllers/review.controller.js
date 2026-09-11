// Reviews, and the one thing that makes them worth having.
//
// A shop selling used phones lives on whether people believe the listings. A
// review anyone can post moves the question from "is this phone any good" to
// "are these reviews real", which is harder to answer and worse to get wrong.
// So every review here is tied to a delivered order belonging to the person
// writing it, and there is no route in that skips that.

const mongoose = require("mongoose");
const Review = require("../models/review.model");
const Order = require("../models/order.model");
const ParentProduct = require("../models/parentProduct.model");
const SingleVariation = require("../models/singleVariation.model");
const AuditLog = require("../models/auditLog.model");

const PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

/**
 * Recomputes a product family's average from its approved reviews.
 *
 * Run on approve and on hide rather than counted on every page load: a
 * product page shows one average, and 954 products would each be an aggregate
 * on every visit.
 *
 * Failures are swallowed by the caller, not here. The rollup is a cached
 * number — losing it means a stale average until the next moderation, which
 * is not a reason to fail the moderation itself.
 */
async function recomputeRating(parentId) {
  const [summary] = await Review.aggregate([
    { $match: { parentId: new mongoose.Types.ObjectId(String(parentId)), status: "APPROVED" } },
    { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);

  // One decimal. A product page shows "4.3", and storing 4.333333 means the
  // number in the database and the number on the screen are different values
  // that have to be rounded the same way in two places.
  const ratingAvg = summary ? Math.round(summary.avg * 10) / 10 : 0;
  const ratingCount = summary ? summary.count : 0;

  await ParentProduct.findByIdAndUpdate(parentId, { $set: { ratingAvg, ratingCount } });

  return { ratingAvg, ratingCount };
}

/**
 * POST /reviews
 *
 * Signed in, their own order, delivered, and the device actually on it. All
 * four, and the last three are the badge.
 */
async function createReview(req, res, next) {
  try {
    const { orderId, productId, rating, title, body } = req.body;

    const order = await Order.findById(orderId).select("userId status items line_items").lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    // Matched on the Clerk id alone, not on the email. An email at checkout is
    // free text — matching on it would let anybody who knows a customer's
    // address review on their behalf.
    if (!order.userId || String(order.userId) !== String(req.user?.id)) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.status !== "Delivered") {
      return res.status(400).json({
        error: "You can review a device once it has been delivered.",
      });
    }

    // Checked in both shapes an order carries its lines in. `items` is the
    // current one; `line_items` is the legacy Stripe-shaped one still on older
    // orders. Missing either would refuse a real customer a real review.
    const onOrder = new Set([
      ...(order.items || []).map((item) => String(item.productId)),
      ...(Array.isArray(order.line_items) ? order.line_items : [])
        .map((line) => line?.price_data?.product_data?.metadata?.productId)
        .filter(Boolean)
        .map(String),
    ]);

    if (!onOrder.has(String(productId))) {
      return res.status(400).json({ error: "That device is not on this order." });
    }

    const variation = await SingleVariation.findById(productId).select("parentCatagory productName").lean();
    if (!variation?.parentCatagory) {
      return res.status(400).json({ error: "That product can no longer be reviewed." });
    }

    const review = await Review.create({
      parentId: variation.parentCatagory,
      productId,
      orderId: order._id,
      userId: req.user.id,
      // From the account, never from the body. A reviewer must not be able to
      // sign their review "UpCell Staff".
      displayName: displayNameFor(req.user),
      rating,
      title,
      body,
      verifiedPurchase: true,
    });

    return res.status(201).json({
      id: review._id,
      status: review.status,
      // Said plainly, because a review that vanishes on submit reads as a
      // failure and the customer writes it again.
      message: "Thanks — your review will appear once we have read it.",
    });
  } catch (error) {
    // The unique index caught a second review of the same item on the same
    // order. A duplicate is not a server fault and should not read as one.
    if (error?.code === 11000) {
      return res.status(409).json({ error: "You have already reviewed this device." });
    }
    return next(error);
  }
}

/**
 * A name to show, from the account rather than from the request.
 *
 * First name and a last initial: enough that reviews read as written by
 * people, without publishing a customer's full name under a purchase.
 */
function displayNameFor(user) {
  const full = String(user?.displayName || user?.name || "").trim();

  if (full) {
    const [first, ...rest] = full.split(/\s+/);
    const initial = rest.length ? ` ${rest[rest.length - 1][0].toUpperCase()}.` : "";
    return `${first}${initial}`.slice(0, 60);
  }

  // No name on the account. The local part of the address is better than
  // "Anonymous", and the domain is nobody's business.
  const email = String(user?.email || "");
  const local = email.split("@")[0];
  return (local || "Verified buyer").slice(0, 60);
}

/**
 * GET /products/:parentId/reviews
 *
 * Public, paginated, approved only.
 */
async function getProductReviews(req, res, next) {
  try {
    const { parentId } = req.params;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || PAGE_SIZE));

    const query = { parentId, status: "APPROVED" };

    const [reviews, totalItems, breakdown] = await Promise.all([
      Review.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // An allowlist. userId, orderId and productId identify a person and a
        // purchase, and none of the three is any of a visitor's business.
        .select("rating title body displayName verifiedPurchase createdAt")
        .lean(),
      Review.countDocuments(query),
      // How many of each star. A single average hides the shape: 4.0 from
      // straight fours and 4.0 from half fives and half threes are different
      // products, and the second is the one a buyer wants to know about.
      Review.aggregate([
        { $match: { parentId: new mongoose.Types.ObjectId(String(parentId)), status: "APPROVED" } },
        { $group: { _id: "$rating", count: { $sum: 1 } } },
      ]),
    ]);

    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    breakdown.forEach((row) => { counts[row._id] = row.count; });

    const total = breakdown.reduce((sum, row) => sum + row._id * row.count, 0);
    const ratingAvg = totalItems ? Math.round((total / totalItems) * 10) / 10 : 0;

    return res.status(200).json({
      items: reviews,
      ratingAvg,
      ratingCount: totalItems,
      counts,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /reviews/mine
 *
 * What this customer has written, and which of their delivered items they
 * still could. Answers the "Write a review" prompt in My Account without the
 * page having to work it out from two other endpoints.
 */
async function getMyReviews(req, res, next) {
  try {
    const reviews = await Review.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .select("orderId productId rating title body status createdAt")
      .lean();

    return res.status(200).json({
      items: reviews,
      // Keyed so a page can ask "has this order item been reviewed" without
      // searching a list on every row.
      reviewed: reviews.map((review) => `${review.orderId}:${review.productId}`),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /admin-reviews
 *
 * The moderation queue. Pending first, because that is the job.
 */
async function getAdminReviews(req, res, next) {
  try {
    const status = String(req.query.status || "PENDING").toUpperCase();
    const query = ["PENDING", "APPROVED", "HIDDEN"].includes(status) ? { status } : {};

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || 25));

    const [items, totalItems] = await Promise.all([
      Review.find(query).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Review.countDocuments(query),
    ]);

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * PATCH /admin-reviews/:id
 *
 * Approve or hide. Audited, because deciding what customers see said about a
 * product is a decision somebody made and should be answerable for.
 */
async function moderateReview(req, res, next) {
  try {
    const { status, moderationNote } = req.body;

    if (!["APPROVED", "HIDDEN"].includes(status)) {
      return res.status(400).json({ error: "A review can be approved or hidden." });
    }

    const review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({ error: "Review not found." });
    }

    // Hiding a review that is already on a product page is the decision worth
    // explaining. Approving one needs no note — the review itself is the note.
    if (status === "HIDDEN" && String(moderationNote || "").trim().length < 5) {
      return res.status(400).json({
        error: "Say why this review is being hidden. An unexplained removal cannot be defended later.",
      });
    }

    review.status = status;
    review.moderatedBy = req.user?.email;
    review.moderatedAt = new Date();
    review.moderationNote = String(moderationNote || "").trim() || undefined;
    await review.save();

    // Best effort. The rollup is a cached number, and a stale average until
    // the next moderation is not a reason to fail a moderation that happened.
    const rating = await recomputeRating(review.parentId).catch(() => null);

    await AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: status === "APPROVED" ? "review.approved" : "review.hidden",
      targetType: "Review",
      targetId: review._id,
      metadata: {
        parentId: String(review.parentId),
        rating: review.rating,
        note: review.moderationNote,
      },
    }).catch(() => {});

    return res.status(200).json({ id: review._id, status: review.status, rating });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createReview,
  getProductReviews,
  getMyReviews,
  getAdminReviews,
  moderateReview,
  recomputeRating,
  displayNameFor,
};
