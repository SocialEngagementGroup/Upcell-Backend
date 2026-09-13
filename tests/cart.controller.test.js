// A saved cart is a promise the shop has not made.
//
// Every catalogue row here is one physical device, so a phone somebody put in
// their cart on Tuesday may be the only one. These tests are mostly about what
// happens when it sells before they come back.

jest.mock("../src/models/cart.model");
jest.mock("../src/models/singleVariation.model");

const Cart = require("../src/models/cart.model");
const SingleVariation = require("../src/models/singleVariation.model");
const controller = require("../src/controllers/cart.controller");

const ID = (n) => String(n).padStart(24, "0");
const A = ID(1);
const B = ID(2);
const C = ID(3);

const makeReqRes = (body = {}, user = { id: "user_1" }) => {
  const req = { body, params: {}, user };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

// Whatever the filter asks for, answer with these ids as if they matched.
const catalogueHas = (...ids) => {
  SingleVariation.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(ids.map((_id) => ({ _id }))) }),
  });
};

const savedCart = (items) => Cart.findOne.mockReturnValue({ lean: () => Promise.resolve(items ? { items } : null) });

beforeEach(() => {
  jest.clearAllMocks();
  Cart.findOneAndUpdate.mockResolvedValue({});
});

describe("reading a saved cart", () => {
  it("gives back what is still buyable", async () => {
    savedCart([A, B]);
    catalogueHas(A, B);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(sent(res).items).toEqual([A, B]);
    expect(sent(res).removed).toBe(0);
  });

  it("drops a device that sold while they were away, and says how many", async () => {
    savedCart([A, B]);
    catalogueHas(A);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(sent(res).items).toEqual([A]);
    // Said plainly, so the page can tell them rather than leaving them to
    // notice a shorter list on their own.
    expect(sent(res).removed).toBe(1);
  });

  it("never writes while reading", async () => {
    // A cart that silently shrinks on GET is one a customer cannot argue with.
    savedCart([A, B]);
    catalogueHas(A);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(Cart.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("answers an empty cart without asking the catalogue anything", async () => {
    savedCart(null);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(sent(res)).toEqual({ items: [], removed: 0 });
    expect(SingleVariation.find).not.toHaveBeenCalled();
  });

  it("only ever reads this customer's cart", async () => {
    savedCart([A]);
    catalogueHas(A);

    const { req, res, next } = makeReqRes({}, { id: "user_7" });
    await controller.getMyCart(req, res, next);

    expect(Cart.findOne).toHaveBeenCalledWith({ userId: "user_7" });
  });
});

describe("what counts as buyable", () => {
  it("excludes sold and unfinished devices", async () => {
    savedCart([A]);
    catalogueHas(A);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    const [filter] = SingleVariation.find.mock.calls[0];
    expect(filter.outOfStock).toEqual({ $ne: true });
    // A device waiting on a battery or a repair is not for sale yet.
    expect(filter.refurbState).toEqual({ $nin: ["NEEDS_BATTERY", "NEEDS_REPAIR"] });
  });

  it("keeps the order the customer put things in", async () => {
    // The cart page removes a line by its position, so reordering the list
    // would remove the wrong one.
    savedCart([C, A, B]);
    catalogueHas(A, B, C);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(sent(res).items).toEqual([C, A, B]);
  });

  it("asks about each device once even when the cart repeats it", async () => {
    savedCart([A, A, B]);
    catalogueHas(A, B);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    const [filter] = SingleVariation.find.mock.calls[0];
    expect(filter._id.$in).toEqual([A, B]);
  });

  it("ignores junk ids instead of letting Mongo throw on them", async () => {
    savedCart(["not-an-id", A]);
    catalogueHas(A);

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(sent(res).items).toEqual([A]);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("saving a cart", () => {
  it("stores what was sent, for this customer only", async () => {
    const { req, res, next } = makeReqRes({ items: [A, B] }, { id: "user_9" });
    await controller.putMyCart(req, res, next);

    const [filter, update, options] = Cart.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ userId: "user_9" });
    expect(update.$set.items.map(String)).toEqual([A, B]);
    expect(options.upsert).toBe(true);
  });

  it("caps the list, because an array from a browser has no natural end", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ID(i + 1));

    const { req, res, next } = makeReqRes({ items: many });
    await controller.putMyCart(req, res, next);

    const [, update] = Cart.findOneAndUpdate.mock.calls[0];
    expect(update.$set.items).toHaveLength(50);
  });

  it("throws away anything that is not an id", async () => {
    const { req, res, next } = makeReqRes({ items: [A, "../../etc/passwd", { $ne: null }, null] });
    await controller.putMyCart(req, res, next);

    const [, update] = Cart.findOneAndUpdate.mock.calls[0];
    expect(update.$set.items.map(String)).toEqual([A]);
  });

  it("accepts an empty cart, because emptying one is a thing people do", async () => {
    const { req, res, next } = makeReqRes({ items: [] });
    await controller.putMyCart(req, res, next);

    const [, update] = Cart.findOneAndUpdate.mock.calls[0];
    expect(update.$set.items).toEqual([]);
    expect(res.statusCode).toBe(200);
  });

  it("survives a body with no items at all", async () => {
    const { req, res, next } = makeReqRes({});
    await controller.putMyCart(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("keeps a device the customer wants twice, rather than deduplicating it", async () => {
    // Two of the same variation cannot be bought, but silently editing
    // somebody's cart behind their back is worse than letting checkout say so.
    const { req, res, next } = makeReqRes({ items: [A, A] });
    await controller.putMyCart(req, res, next);

    const [, update] = Cart.findOneAndUpdate.mock.calls[0];
    expect(update.$set.items.map(String)).toEqual([A, A]);
  });
});

describe("failures", () => {
  it("hands a database error to the error handler rather than answering", async () => {
    Cart.findOne.mockReturnValue({ lean: () => Promise.reject(new Error("mongo down")) });

    const { req, res, next } = makeReqRes();
    await controller.getMyCart(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
