jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/parentProduct.model");

const mongoose = require("mongoose");
const SingleVariation = require("../src/models/singleVariation.model");
const product = require("../src/controllers/product.controller");

// Without this, mock.calls[0] in a later describe block silently refers to
// the first call made anywhere in this file, not that test's own call — a
// real gap this file had until the getAdminProducts tests exposed it.
beforeEach(() => {
  jest.clearAllMocks();
});

const makeRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload) => { res.body = payload; return res; });
  // Express's own res.set, which getShopProducts uses to send Cache-Control.
  // Without it the controller throws into next() and every assertion about
  // the body reads null instead of the response.
  res.set = jest.fn((name, value) => { res.headers[name] = value; return res; });
  return res;
};

// A mongoose query is both chainable (.sort().lean()) and, via .lean(),
// resolves to the array — mocked the same way other tests in this repo mock
// SingleVariation.find.
const mockFindChain = (docs) => {
  SingleVariation.find.mockReturnValue({
    sort: () => ({ lean: async () => docs }),
  });
};

describe("getShopProducts — the shop page's data source", () => {
  const variations = [
    { _id: "v1", parentCatagory: "p1", productName: "iPhone 15", price: 699, outOfStock: false },
    { _id: "v2", parentCatagory: "p1", productName: "iPhone 15", price: 649, outOfStock: false },
    { _id: "v3", parentCatagory: "p2", productName: "iPad Air", price: 499, outOfStock: true },
  ];

  it("returns individual variations, not grouped cards — grouping is the shop page's own job", async () => {
    mockFindChain(variations);

    const res = makeRes();
    await product.getShopProducts({}, res, jest.fn());

    // Two variations share parentCatagory p1 — if this endpoint grouped them,
    // there would be one row per parent (2 total), not one per variation (3).
    expect(res.body).toHaveLength(3);
    expect(res.body).toEqual(variations);
  });

  it("lets the browser cache the listing, so a repeat visit revalidates instead of redownloading", async () => {
    mockFindChain(variations);

    const res = makeRes();
    await product.getShopProducts({}, res, jest.fn());

    // public — identical for every visitor, nothing per-user in it.
    // max-age matches the frontend's React Query staleTime of 60s.
    expect(res.headers["Cache-Control"]).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("only asks for browsable products — accessories are excluded", async () => {
    mockFindChain(variations);

    await product.getShopProducts({}, makeRes(), jest.fn());

    const [query] = SingleVariation.find.mock.calls[0];
    expect(query).toMatchObject({ isAccessory: { $ne: true } });
  });

  it("only asks for the fields a listing card actually needs", async () => {
    mockFindChain(variations);

    await product.getShopProducts({}, makeRes(), jest.fn());

    const [, fields] = SingleVariation.find.mock.calls[0];
    expect(fields).toBe(
      "parentCatagory productName categoryName description storage color price image outOfStock"
    );
  });

  it("passes errors to next() instead of leaving the request hanging", async () => {
    SingleVariation.find.mockReturnValue({
      sort: () => ({ lean: async () => { throw new Error("db down"); } }),
    });
    const next = jest.fn();

    await product.getShopProducts({}, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("getAdminProducts — the admin product-management pages' data source", () => {
  const variations = [
    { _id: "v1", parentCatagory: "p1", productName: "iPhone 15", price: 699, isAccessory: false },
    { _id: "v2", parentCatagory: "p2", productName: "Case", price: 19, isAccessory: true },
  ];

  // No .sort() in this chain, unlike getShopProducts — a plain .find().lean().
  const mockPlainFindChain = (docs) => {
    SingleVariation.find.mockReturnValue({ lean: async () => docs });
  };

  it("does not group — AllProduct/AddProduct build their own groupings", async () => {
    mockPlainFindChain(variations);

    const res = makeRes();
    await product.getAdminProducts({}, res, jest.fn());

    expect(res.body).toEqual(variations);
  });

  it("includes accessories, unlike the public shop endpoint", async () => {
    mockPlainFindChain(variations);

    await product.getAdminProducts({}, makeRes(), jest.fn());

    const [query] = SingleVariation.find.mock.calls[0];
    expect(query).toEqual({});
  });

  it("only asks for the fields these two admin pages actually render or edit", async () => {
    mockPlainFindChain(variations);

    await product.getAdminProducts({}, makeRes(), jest.fn());

    const [, fields] = SingleVariation.find.mock.calls[0];
    expect(fields).toBe(
      "parentCatagory productName categoryName storage color price discountPrice originalPrice outOfStock image"
    );
  });

  it("passes errors to next() instead of leaving the request hanging", async () => {
    SingleVariation.find.mockReturnValue({ lean: async () => { throw new Error("db down"); } });
    const next = jest.fn();

    await product.getAdminProducts({}, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("getProducts — the full catalogue endpoint", () => {
  it("returns every variation", async () => {
    const docs = [{ _id: "v1" }, { _id: "v2" }];
    SingleVariation.find.mockReturnValue({ lean: async () => docs });

    const res = makeRes();
    await product.getProducts({}, res, jest.fn());

    expect(res.body).toEqual(docs);
  });

  // This was the only controller in the codebase without a try/catch. A
  // rejected query never reached the error middleware, so instead of a clean
  // 500 the request hung until the client gave up.
  it("passes errors to next() instead of leaving the request hanging", async () => {
    SingleVariation.find.mockReturnValue({ lean: async () => { throw new Error("db down"); } });
    const next = jest.fn();

    await product.getProducts({}, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// The grouping moved into MongoDB. It used to read every browsable variation
// (937 of them), build the cards in Node and throw all but four away; now the
// database groups and limits, and only the rendered cards come back — 614ms to
// 289ms against the real catalogue.
//
// What that costs in testing: the grouping itself is now Mongo's work, and a
// mocked aggregate cannot prove it. These tests assert the pipeline is built
// correctly; that one card comes back per family, with its colours intact,
// needs an integration test against a real database.
describe("getRecommendedProducts — groups in the database", () => {
  const stage = (pipeline, key) => pipeline.find((step) => key in step);

  it("returns the cards the aggregation produced", async () => {
    const cards = [{ _id: "v1", productName: "iPhone 15", price: 649 }];
    SingleVariation.aggregate.mockResolvedValue(cards);

    const res = makeRes();
    await product.getRecommendedProducts({ query: {} }, res, jest.fn());

    expect(res.body).toEqual(cards);
  });

  it("collects colours and storages in the same pass, so swatches survive", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    await product.getRecommendedProducts({ query: {} }, makeRes(), jest.fn());

    const group = stage(SingleVariation.aggregate.mock.calls[0][0], "$group").$group;
    // Taking $first alone would be faster and would quietly drop every swatch.
    expect(group.availableColors).toBeDefined();
    expect(group.availableStorages).toBeDefined();
    expect(group.doc).toEqual({ $first: "$$ROOT" });
  });

  it("sorts in-stock first, then cheapest, so $first picks a buyable variant", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    await product.getRecommendedProducts({ query: {} }, makeRes(), jest.fn());

    const sort = stage(SingleVariation.aggregate.mock.calls[0][0], "$sort").$sort;
    expect(sort).toEqual({ outOfStock: 1, price: 1 });
  });

  // Mongoose casts a string to an ObjectId for find(), but not inside an
  // aggregation. Left as a string the $ne matches nothing, and a product page
  // recommends its own family straight back to itself.
  it("casts excludeParentId to an ObjectId, or the exclusion silently fails", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);
    const parentId = "6a9adcc3acb45145487d7a23";

    await product.getRecommendedProducts({ query: { excludeParentId: parentId } }, makeRes(), jest.fn());

    const match = stage(SingleVariation.aggregate.mock.calls[0][0], "$match").$match;
    expect(match.parentCatagory.$ne).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(match.parentCatagory.$ne)).toBe(parentId);
  });

  it("ignores an excludeParentId that is not a real id rather than throwing", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    await product.getRecommendedProducts({ query: { excludeParentId: "nonsense" } }, makeRes(), jest.fn());

    const match = stage(SingleVariation.aggregate.mock.calls[0][0], "$match").$match;
    expect(match.parentCatagory).toBeUndefined();
  });

  it("caps the limit at 12 however large a number is asked for", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    await product.getRecommendedProducts({ query: { limit: "500" } }, makeRes(), jest.fn());

    const limit = stage(SingleVariation.aggregate.mock.calls[0][0], "$limit").$limit;
    expect(limit).toBe(12);
  });

  it("passes errors to next() instead of leaving the request hanging", async () => {
    SingleVariation.aggregate.mockRejectedValue(new Error("db down"));
    const next = jest.fn();

    await product.getRecommendedProducts({ query: {} }, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
