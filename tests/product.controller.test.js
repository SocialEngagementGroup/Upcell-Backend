jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/parentProduct.model");
jest.mock("../src/models/availableCategory.model");

const SingleVariation = require("../src/models/singleVariation.model");
const product = require("../src/controllers/product.controller");

// Without this, mock.calls[0] in a later describe block silently refers to
// the first call made anywhere in this file, not that test's own call — a
// real gap this file had until the getAdminProducts tests exposed it.
beforeEach(() => {
  jest.clearAllMocks();
});

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload) => { res.body = payload; return res; });
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

describe("getRecommendedProducts — still groups (a small, separate use case)", () => {
  it("still collapses variations to one card per parent product", async () => {
    const variations = [
      { _id: "v1", parentCatagory: "p1", productName: "iPhone 15", price: 699, outOfStock: false },
      { _id: "v2", parentCatagory: "p1", productName: "iPhone 15", price: 649, outOfStock: false },
    ];
    mockFindChain(variations);

    const res = makeRes();
    await product.getRecommendedProducts({ query: {} }, res, jest.fn());

    // Recommendations show one card per distinct product, unlike the shop
    // page's own data source above — this is a genuinely different, small
    // (limit 4-12) use case, not the same duplicated logic.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].price).toBe(649); // cheapest in-stock variant wins
  });
});
