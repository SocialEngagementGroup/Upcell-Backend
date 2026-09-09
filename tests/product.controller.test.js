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
      // imagePublicId is the fallback resolveProductImage uses when the image
      // manifest has no photo for a product. Dropping it from this projection
      // broke the image on every newly added product.
      "slug imagePublicId imageIsGeneric parentCatagory productName categoryName description storage color price image outOfStock"
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
      "parentCatagory productName categoryName storage color price discountPrice originalPrice outOfStock image imagePublicId imageIsGeneric"
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

// createProduct is what the admin "Save product" button calls, and until now
// nothing tested it. Two bugs shipped through that gap and were found by hand
// on the live site: variants were written with no slug, so a saved product had
// no address and search could not open it; and the image an admin uploaded was
// stored without its Cloudinary id, which let the frontend's image matcher
// substitute a different photo. Both are asserted here.
describe("createProduct — the admin Save product button", () => {
  const ParentProduct = require("../src/models/parentProduct.model");

  const makeReq = (overrides = {}) => ({
    body: {
      productName: "iPhone Air",
      categoryName: "iPhone",
      categoryId: "cat1",
      image: "https://res.cloudinary.com/x/image/upload/upcell/products/iphone/air--abc123",
      images: [{
        url: "https://res.cloudinary.com/x/image/upload/upcell/products/iphone/air--abc123",
        publicId: "upcell/products/iphone/air--abc123",
      }],
      variants: [
        { storage: "256GB", color: { name: "Sky Blue" }, price: 999 },
        { storage: "512GB", color: { name: "Sky Blue" }, price: 1199 },
      ],
      ...overrides,
    },
  });

  beforeEach(() => {
    ParentProduct.findById.mockResolvedValue(null);
    ParentProduct.findOne.mockResolvedValue(null);
    ParentProduct.exists.mockResolvedValue(false);
    ParentProduct.create.mockImplementation(async (doc) => ({ _id: "parent1", ...doc }));
    SingleVariation.exists.mockResolvedValue(false);
    SingleVariation.insertMany.mockImplementation(async (docs) => docs);
  });

  const savedVariants = () => SingleVariation.insertMany.mock.calls[0][0];

  it("gives every variant a slug, because the slug is the whole address of its page", async () => {
    const res = makeRes();
    await product.createProduct(makeReq(), res, jest.fn());

    expect(savedVariants().map((variant) => variant.slug)).toEqual([
      "iphone-air-256gb-sky-blue",
      "iphone-air-512gb-sky-blue",
    ]);
  });

  it("gives the parent a slug too", async () => {
    await product.createProduct(makeReq(), makeRes(), jest.fn());

    expect(ParentProduct.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "iphone-air" })
    );
  });

  it("keeps the Cloudinary id of the uploaded image, not just its URL", async () => {
    await product.createProduct(makeReq(), makeRes(), jest.fn());

    // Without the id there is no way to ask for the photo at a card's width or
    // in a modern format — a stored URL is one fixed rendition.
    for (const variant of savedVariants()) {
      expect(variant.imagePublicId).toBe("upcell/products/iphone/air--abc123");
    }
  });

  it("marks an uploaded photo as the product's own, so nothing substitutes another for it", async () => {
    await product.createProduct(makeReq(), makeRes(), jest.fn());

    for (const variant of savedVariants()) {
      expect(variant.imageIsGeneric).toBe(false);
    }
  });

  it("writes isAccessory explicitly, so the field exists for the index to use", async () => {
    await product.createProduct(makeReq(), makeRes(), jest.fn());

    for (const variant of savedVariants()) {
      expect(variant.isAccessory).toBe(false);
    }
  });

  it("gives two variants that slugify identically distinct slugs", async () => {
    const req = makeReq({
      variants: [
        { storage: "256GB", color: { name: "Sky Blue" }, price: 999 },
        { storage: "256GB", color: { name: "sky blue" }, price: 999 },
      ],
    });

    await product.createProduct(req, makeRes(), jest.fn());

    const slugs = savedVariants().map((variant) => variant.slug);
    expect(new Set(slugs).size).toBe(2);
  });

  it("falls back to the plain image field when no image refs are sent", async () => {
    const req = makeReq({ images: undefined });

    await product.createProduct(req, makeRes(), jest.fn());

    expect(savedVariants()[0].image).toBe(req.body.image);
    expect(savedVariants()[0].imagePublicId).toBeUndefined();
  });
});
