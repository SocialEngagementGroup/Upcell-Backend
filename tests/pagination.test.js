const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../src/utils/pagination");

describe("getAdminListPagination", () => {
  it("defaults to page 1, limit 10 when nothing is provided", () => {
    expect(getAdminListPagination({ query: {} })).toEqual({ page: 1, limit: 10, skip: 0 });
  });

  it("parses valid page/limit from the query string", () => {
    expect(getAdminListPagination({ query: { page: "3", limit: "20" } })).toEqual({
      page: 3,
      limit: 20,
      skip: 40,
    });
  });

  it("falls back to page 1 for a non-numeric page value", () => {
    expect(getAdminListPagination({ query: { page: "not-a-number" } }).page).toBe(1);
  });

  it("falls back to page 1 for a zero or negative page value", () => {
    expect(getAdminListPagination({ query: { page: "0" } }).page).toBe(1);
    expect(getAdminListPagination({ query: { page: "-5" } }).page).toBe(1);
  });

  it("caps limit at 50 even if a larger value is requested", () => {
    expect(getAdminListPagination({ query: { limit: "500" } }).limit).toBe(50);
  });

  it("falls back to the default limit for a zero or negative limit value", () => {
    expect(getAdminListPagination({ query: { limit: "0" } }).limit).toBe(10);
    expect(getAdminListPagination({ query: { limit: "-1" } }).limit).toBe(10);
  });

  it("computes skip correctly for page > 1", () => {
    expect(getAdminListPagination({ query: { page: "5", limit: "10" } }).skip).toBe(40);
  });
});

describe("emptyPaginatedResponse", () => {
  it("returns a well-formed empty page", () => {
    const res = { status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    emptyPaginatedResponse({ res, page: 2, limit: 10 });

    expect(res.statusCode).toBe(200);
    expect(res.json).toHaveBeenCalledWith({
      items: [],
      pagination: { page: 2, limit: 10, totalItems: 0, totalPages: 1 },
    });
  });
});

describe("sendPaginatedResults", () => {
  const makeModel = (items, totalItems) => {
    const chain = {};
    chain.sort = jest.fn(() => chain);
    chain.skip = jest.fn(() => chain);
    chain.limit = jest.fn(() => Promise.resolve(items));
    return {
      find: jest.fn(() => chain),
      countDocuments: jest.fn().mockResolvedValue(totalItems),
      _chain: chain,
    };
  };

  it("returns items plus correct pagination metadata", async () => {
    const model = makeModel([{ _id: "1" }, { _id: "2" }], 23);
    const res = { status(code) { this.statusCode = code; return this; }, json: jest.fn() };

    await sendPaginatedResults({ res, model, query: { status: "Shipped" }, sort: { createdAt: -1 }, page: 2, limit: 10, skip: 10 });

    expect(model.find).toHaveBeenCalledWith({ status: "Shipped" });
    expect(model._chain.skip).toHaveBeenCalledWith(10);
    expect(model._chain.limit).toHaveBeenCalledWith(10);
    expect(res.json).toHaveBeenCalledWith({
      items: [{ _id: "1" }, { _id: "2" }],
      pagination: { page: 2, limit: 10, totalItems: 23, totalPages: 3 },
    });
  });

  it("totalPages is never less than 1, even with zero results", async () => {
    const model = makeModel([], 0);
    const res = { status(code) { this.statusCode = code; return this; }, json: jest.fn() };

    await sendPaginatedResults({ res, model, query: {}, sort: {}, page: 1, limit: 10, skip: 0 });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ pagination: expect.objectContaining({ totalPages: 1 }) }));
  });
});
