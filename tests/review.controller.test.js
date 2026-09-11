jest.mock("../src/models/review.model");
jest.mock("../src/models/order.model");
jest.mock("../src/models/parentProduct.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/auditLog.model");

const Review = require("../src/models/review.model");
const Order = require("../src/models/order.model");
const ParentProduct = require("../src/models/parentProduct.model");
const SingleVariation = require("../src/models/singleVariation.model");
const AuditLog = require("../src/models/auditLog.model");
const controller = require("../src/controllers/review.controller");

const ORDER_ID = "a".repeat(24);
const PRODUCT_ID = "b".repeat(24);
const PARENT_ID = "c".repeat(24);

const CUSTOMER = { id: "user_1", email: "buyer@example.com", displayName: "Sam Okonkwo" };
const STAFF = { id: "user_admin", email: "yasir@upcellit.com", role: "admin" };

const makeReqRes = (body = {}, { params = {}, query = {}, user = CUSTOMER } = {}) => {
  const req = { body, params, query, user };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

const deliveredOrder = (over = {}) => ({
  _id: ORDER_ID,
  userId: "user_1",
  status: "Delivered",
  items: [{ productId: PRODUCT_ID, name: "iPhone 13" }],
  ...over,
});

const orderResolves = (order) => Order.findById.mockReturnValue({
  select: () => ({ lean: () => Promise.resolve(order) }),
});

const variationResolves = (doc) => SingleVariation.findById.mockReturnValue({
  select: () => ({ lean: () => Promise.resolve(doc) }),
});

const validBody = (over = {}) => ({
  orderId: ORDER_ID, productId: PRODUCT_ID, rating: 5, title: "Great", body: "Works well.", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  orderResolves(deliveredOrder());
  variationResolves({ _id: PRODUCT_ID, parentCatagory: PARENT_ID, productName: "iPhone 13" });
  Review.create.mockResolvedValue({ _id: "rev1", status: "PENDING" });
  Review.aggregate.mockResolvedValue([]);
  ParentProduct.findByIdAndUpdate.mockResolvedValue({});
  AuditLog.create.mockResolvedValue({});
});

// A review anyone can post moves the question from "is this phone any good"
// to "are these reviews real", which is harder to answer and worse to get
// wrong. These four checks are what the badge means.
describe("who is allowed to write one", () => {
  it("accepts a customer reviewing their own delivered device", async () => {
    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(201);
    expect(Review.create).toHaveBeenCalled();
  });

  it("refuses somebody else's order, and does not say it exists", async () => {
    orderResolves(deliveredOrder({ userId: "user_2" }));

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    // 404 rather than 403: confirming an order id belongs to somebody is
    // itself worth knowing to whoever is guessing them.
    expect(res.statusCode).toBe(404);
    expect(Review.create).not.toHaveBeenCalled();
  });

  it("matches on the Clerk id, never on the email", async () => {
    // An email at checkout is free text. Matching on it would let anybody who
    // knows a customer's address review on their behalf.
    orderResolves(deliveredOrder({ userId: null, email: "buyer@example.com" }));

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(404);
  });

  it("refuses an order that has not been delivered", async () => {
    orderResolves(deliveredOrder({ status: "Shipped" }));

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("delivered");
  });

  it("refuses a device that is not on the order", async () => {
    const { req, res, next } = makeReqRes(validBody({ productId: "d".repeat(24) }));
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("not on this order");
  });

  it("reads the legacy line_items shape too", async () => {
    // Older orders carry their lines in the Stripe-shaped field. Missing it
    // would refuse a real customer a real review.
    orderResolves({
      _id: ORDER_ID,
      userId: "user_1",
      status: "Delivered",
      line_items: [{ price_data: { product_data: { metadata: { productId: PRODUCT_ID } } } }],
    });

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(201);
  });

  it("says plainly when the customer has already reviewed it", async () => {
    // The unique index caught it. A duplicate is not a server fault.
    Review.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(sent(res).error).toContain("already reviewed");
  });

  it("refuses a product that has left the catalogue", async () => {
    variationResolves(null);

    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(res.statusCode).toBe(400);
  });
});

describe("what gets written", () => {
  it("files the review under the product family, not the single unit", async () => {
    // A review of one 128GB Midnight unit is a review of the iPhone 13 as far
    // as the next buyer is concerned.
    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    const [doc] = Review.create.mock.calls[0];
    expect(String(doc.parentId)).toBe(PARENT_ID);
    expect(String(doc.productId)).toBe(PRODUCT_ID);
  });

  it("marks it a verified purchase, because it is", async () => {
    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(Review.create.mock.calls[0][0].verifiedPurchase).toBe(true);
  });

  it("takes the reviewer's name from the account, never from the body", async () => {
    // Otherwise somebody signs their review "UpCell Staff".
    const { req, res, next } = makeReqRes(validBody({ displayName: "UpCell Staff" }));
    await controller.createReview(req, res, next);

    expect(Review.create.mock.calls[0][0].displayName).toBe("Sam O.");
  });

  it("holds it back until somebody has read it", async () => {
    // The cost of a slow review is a customer waiting a day. The cost of an
    // automatic one is whatever they typed appearing under a product.
    const { req, res, next } = makeReqRes(validBody());
    await controller.createReview(req, res, next);

    expect(Review.create.mock.calls[0][0].status).toBeUndefined();
    expect(sent(res).message).toContain("once we have read it");
  });
});

describe("the name shown next to a review", () => {
  it("is a first name and a last initial", () => {
    expect(controller.displayNameFor({ displayName: "Sam Okonkwo" })).toBe("Sam O.");
  });

  it("handles a middle name by using the last one", () => {
    expect(controller.displayNameFor({ displayName: "Ana Maria Silva" })).toBe("Ana S.");
  });

  it("copes with a single name", () => {
    expect(controller.displayNameFor({ displayName: "Prince" })).toBe("Prince");
  });

  it("falls back to the local part of the address, not the domain", () => {
    expect(controller.displayNameFor({ email: "sam@example.com" })).toBe("sam");
  });

  it("never publishes a full email address", () => {
    expect(controller.displayNameFor({ email: "sam@example.com" })).not.toContain("@");
  });

  it("has something to say for an account with neither", () => {
    expect(controller.displayNameFor({})).toBe("Verified buyer");
  });
});

describe("what the product page sees", () => {
  // Records the field list the controller asked for, so the allowlist can be
  // asserted rather than assumed.
  let selectedFields;
  const listResolves = (rows) => Review.find.mockReturnValue({
    sort: () => ({
      skip: () => ({
        limit: () => ({
          select: (fields) => { selectedFields = fields; return { lean: () => Promise.resolve(rows) }; },
        }),
      }),
    }),
  });

  beforeEach(() => {
    listResolves([{ rating: 5, title: "Great", displayName: "Sam O." }]);
    Review.countDocuments.mockResolvedValue(1);
    Review.aggregate.mockResolvedValue([{ _id: 5, count: 1 }]);
  });

  it("shows only approved reviews", async () => {
    const { req, res, next } = makeReqRes({}, { params: { parentId: PARENT_ID }, user: null });
    await controller.getProductReviews(req, res, next);

    expect(Review.find.mock.calls[0][0]).toEqual({ parentId: PARENT_ID, status: "APPROVED" });
  });

  it("never sends who wrote it or what they bought", async () => {
    // userId, orderId and productId identify a person and a purchase, and
    // none of the three is a visitor's business. An allowlist rather than a
    // denylist, so a field added to the model is not published by default.
    const { req, res, next } = makeReqRes({}, { params: { parentId: PARENT_ID }, user: null });
    await controller.getProductReviews(req, res, next);

    expect(selectedFields).toBe("rating title body displayName verifiedPurchase createdAt");
    expect(selectedFields).not.toContain("userId");
    expect(selectedFields).not.toContain("orderId");
    expect(selectedFields).not.toContain("productId");
  });

  it("sends the spread of stars, not only the average", async () => {
    // 4.0 from straight fours and 4.0 from half fives and half threes are
    // different products, and the second is the one a buyer wants to know.
    Review.aggregate.mockResolvedValue([{ _id: 5, count: 2 }, { _id: 3, count: 2 }]);
    Review.countDocuments.mockResolvedValue(4);

    const { req, res, next } = makeReqRes({}, { params: { parentId: PARENT_ID }, user: null });
    await controller.getProductReviews(req, res, next);

    expect(sent(res).counts).toEqual({ 1: 0, 2: 0, 3: 2, 4: 0, 5: 2 });
    expect(sent(res).ratingAvg).toBe(4);
  });

  it("answers a product with no reviews with zero, not with nothing", async () => {
    listResolves([]);
    Review.countDocuments.mockResolvedValue(0);
    Review.aggregate.mockResolvedValue([]);

    const { req, res, next } = makeReqRes({}, { params: { parentId: PARENT_ID }, user: null });
    await controller.getProductReviews(req, res, next);

    expect(sent(res).ratingAvg).toBe(0);
    expect(sent(res).ratingCount).toBe(0);
  });

  it("caps the page size a caller can ask for", async () => {
    const { req, res, next } = makeReqRes({}, { params: { parentId: PARENT_ID }, query: { limit: "5000" }, user: null });
    await controller.getProductReviews(req, res, next);

    expect(sent(res).pagination.limit).toBe(50);
  });
});

describe("moderation", () => {
  const reviewDoc = (over = {}) => ({
    _id: "rev1",
    parentId: PARENT_ID,
    rating: 5,
    status: "PENDING",
    save: jest.fn().mockResolvedValue(true),
    ...over,
  });

  it("approves a review and recomputes the average", async () => {
    const review = reviewDoc();
    Review.findById.mockResolvedValue(review);
    Review.aggregate.mockResolvedValue([{ _id: null, avg: 4.3333, count: 3 }]);

    const { req, res, next } = makeReqRes({ status: "APPROVED" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(review.status).toBe("APPROVED");
    // Rounded to one decimal here, so the number stored and the number shown
    // are the same value rather than rounded twice in two places.
    expect(ParentProduct.findByIdAndUpdate).toHaveBeenCalledWith(
      PARENT_ID, { $set: { ratingAvg: 4.3, ratingCount: 3 } }
    );
  });

  it("will not hide one without saying why", async () => {
    Review.findById.mockResolvedValue(reviewDoc({ status: "APPROVED" }));

    const { req, res, next } = makeReqRes({ status: "HIDDEN" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("why");
  });

  it("hides one with a note", async () => {
    const review = reviewDoc({ status: "APPROVED" });
    Review.findById.mockResolvedValue(review);

    const { req, res, next } = makeReqRes(
      { status: "HIDDEN", moderationNote: "Names a competitor's price" },
      { params: { id: "rev1" }, user: STAFF }
    );
    await controller.moderateReview(req, res, next);

    expect(review.status).toBe("HIDDEN");
    expect(review.moderationNote).toBe("Names a competitor's price");
  });

  it("needs no note to approve — the review is the note", async () => {
    Review.findById.mockResolvedValue(reviewDoc());

    const { req, res, next } = makeReqRes({ status: "APPROVED" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(res.statusCode).toBe(200);
  });

  it("records who decided", async () => {
    // Deciding what customers see said about a product is a decision somebody
    // made and should be answerable for.
    Review.findById.mockResolvedValue(reviewDoc());

    const { req, res, next } = makeReqRes({ status: "APPROVED" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(AuditLog.create.mock.calls[0][0]).toMatchObject({
      action: "review.approved",
      targetType: "Review",
      actorEmail: "yasir@upcellit.com",
    });
  });

  it("refuses a status that is not approve or hide", async () => {
    const { req, res, next } = makeReqRes({ status: "PENDING" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("still reports success when the rollup fails", async () => {
    // The rollup is a cached number. A stale average until the next
    // moderation is not a reason to fail a moderation that happened.
    Review.findById.mockResolvedValue(reviewDoc());
    ParentProduct.findByIdAndUpdate.mockRejectedValue(new Error("mongo down"));

    const { req, res, next } = makeReqRes({ status: "APPROVED" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(next).not.toHaveBeenCalled();
  });

  it("counts only approved reviews into the average", async () => {
    Review.findById.mockResolvedValue(reviewDoc());

    const { req, res, next } = makeReqRes({ status: "APPROVED" }, { params: { id: "rev1" }, user: STAFF });
    await controller.moderateReview(req, res, next);

    const [pipeline] = Review.aggregate.mock.calls[0];
    expect(pipeline[0].$match.status).toBe("APPROVED");
  });

  it("sets the average to zero when the last review is hidden", async () => {
    Review.findById.mockResolvedValue(reviewDoc({ status: "APPROVED" }));
    Review.aggregate.mockResolvedValue([]);

    const { req, res, next } = makeReqRes(
      { status: "HIDDEN", moderationNote: "Not about this product" },
      { params: { id: "rev1" }, user: STAFF }
    );
    await controller.moderateReview(req, res, next);

    expect(ParentProduct.findByIdAndUpdate).toHaveBeenCalledWith(
      PARENT_ID, { $set: { ratingAvg: 0, ratingCount: 0 } }
    );
  });
});
