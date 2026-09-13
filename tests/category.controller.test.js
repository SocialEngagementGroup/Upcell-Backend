jest.mock("../src/models/parentProduct.model");
jest.mock("../src/models/shopCategory.model");

const ParentProduct = require("../src/models/parentProduct.model");
const category = require("../src/controllers/category.controller");

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload) => { res.body = payload; return res; });
  return res;
};

// The admin categories page used to fetch every ParentProduct and every
// SingleVariation just to count matches per parent in a JavaScript loop —
// this replaces that with one $lookup/$group aggregation. These tests
// verify the pipeline shape, not real Mongo aggregation semantics (that was
// verified directly against the live database when this pattern was first
// introduced for the admin revenue dashboards).
describe("getCategoriesWithProductCounts", () => {
  it("joins against the correct collection and field names", async () => {
    ParentProduct.aggregate.mockResolvedValue([]);

    await category.getCategoriesWithProductCounts({}, makeRes(), jest.fn());

    const [pipeline] = ParentProduct.aggregate.mock.calls[0];
    const lookupStage = pipeline.find((stage) => stage.$lookup);
    expect(lookupStage.$lookup).toEqual({
      from: "singlevariations",
      localField: "_id",
      foreignField: "parentCatagory",
      as: "variants",
    });
  });

  it("projects a variant count and one sample price, not the raw variant list", async () => {
    ParentProduct.aggregate.mockResolvedValue([]);

    await category.getCategoriesWithProductCounts({}, makeRes(), jest.fn());

    const [pipeline] = ParentProduct.aggregate.mock.calls[0];
    const projectStage = pipeline.find((stage) => stage.$project);
    expect(projectStage.$project.variantCount).toEqual({ $size: "$variants" });
    expect(projectStage.$project.samplePrice).toEqual({ $arrayElemAt: ["$variants.price", 0] });
    // The whole point: never project the joined array itself back out.
    expect(projectStage.$project.variants).toBeUndefined();
  });

  it("returns whatever the aggregation produces, unmodified", async () => {
    const rows = [
      { _id: "p1", modelName: "iPhone 17e", categoryName: "iPhone", variantCount: 6, samplePrice: 699 },
      { _id: "p2", modelName: "iPad Air", categoryName: "iPad", variantCount: 0, samplePrice: undefined },
    ];
    ParentProduct.aggregate.mockResolvedValue(rows);

    const res = makeRes();
    await category.getCategoriesWithProductCounts({}, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(rows);
  });

  it("passes errors to next() instead of leaving the request hanging", async () => {
    ParentProduct.aggregate.mockRejectedValue(new Error("db down"));
    const next = jest.fn();

    await category.getCategoriesWithProductCounts({}, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// The seed check is a round trip, and on a shared Atlas tier a round trip is
// about 300ms whatever it asks for. This endpoint returns ten rows that
// change a few times a year and was paying that on every single request.
describe("getShopCategories — seeding once, not per request", () => {
  // The seed is memoised per process, so every test needs a fresh module
  // registry. Both the controller and the mocked model are required inside
  // that fresh registry, or the test would be holding a different mock than
  // the one the controller calls.
  let controller;
  let ShopCategory;
  let defaults;

  beforeEach(() => {
    jest.resetModules();
    ShopCategory = require("../src/models/shopCategory.model");
    controller = require("../src/controllers/category.controller");
    defaults = require("../src/constants/shopCategoryDefaults").SHOP_CATEGORY_DEFAULTS;
    ShopCategory.find.mockReset();
    ShopCategory.insertMany.mockReset();
    ShopCategory.insertMany.mockResolvedValue([]);
  });

  // The seed's own read is projected and lean; the listing read sorts first.
  const answering = (docs) => {
    ShopCategory.find.mockImplementation((filter, projection) =>
      projection ? { lean: async () => docs } : { sort: () => ({ lean: async () => docs }) });
  };

  const allPresent = () => defaults.map((item) => ({ modelName: item.modelName }));

  it("checks for missing categories only once, however many requests arrive", async () => {
    answering(allPresent());

    await controller.getShopCategories({}, makeRes(), jest.fn());
    await controller.getShopCategories({}, makeRes(), jest.fn());
    await controller.getShopCategories({}, makeRes(), jest.fn());

    // Three listings, one seed check. Each one used to cost a round trip, and
    // on a shared Atlas tier a round trip is about 300ms whatever it asks for.
    const seedReads = ShopCategory.find.mock.calls.filter(([, projection]) => projection);
    expect(seedReads).toHaveLength(1);
    expect(ShopCategory.find).toHaveBeenCalledTimes(4);
  });

  it("still seeds a category that is missing", async () => {
    answering([{ modelName: defaults[0].modelName }]);

    await controller.getShopCategories({}, makeRes(), jest.fn());

    const [inserted] = ShopCategory.insertMany.mock.calls[0];
    expect(inserted).toHaveLength(defaults.length - 1);
  });

  it("seeds nothing when every category is already there", async () => {
    answering(allPresent());

    await controller.getShopCategories({}, makeRes(), jest.fn());

    expect(ShopCategory.insertMany).not.toHaveBeenCalled();
  });

  it("tries again on the next request when the seed failed", async () => {
    // A connection that was not ready yet must not leave the categories
    // missing for the life of the process.
    ShopCategory.find.mockImplementationOnce(() => ({
      lean: async () => { throw new Error("not connected"); },
    }));

    await controller.getShopCategories({}, makeRes(), jest.fn());

    answering([]);
    await controller.getShopCategories({}, makeRes(), jest.fn());

    expect(ShopCategory.insertMany).toHaveBeenCalledTimes(1);
  });

  it("reports a seed failure rather than answering with nothing", async () => {
    ShopCategory.find.mockImplementationOnce(() => ({
      lean: async () => { throw new Error("not connected"); },
    }));
    const next = jest.fn();

    await controller.getShopCategories({}, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
