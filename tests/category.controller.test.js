jest.mock("../src/models/parentProduct.model");
jest.mock("../src/models/availableCategory.model");
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
