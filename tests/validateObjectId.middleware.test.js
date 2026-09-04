const { validateObjectIdParam } = require("../src/middleware/validateObjectId.middleware");

const makeReqRes = (params) => {
  const req = { params };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return { req, res, next };
};

// A malformed :id used to reach a controller's findById unchecked, throwing a
// Mongoose CastError the global handler could not tell apart from a real
// fault — answering with a 500 and paging the admin over a crawler probing
// /product/abc. This is the guard that stops it before the controller runs.
describe("validateObjectIdParam", () => {
  it("passes a well-formed 24-character hex id through to the controller", () => {
    const { req, res, next } = makeReqRes({ id: "6a79f7298341f33d9a65b0b7" });

    validateObjectIdParam()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
  });

  it("rejects a malformed id with a plain 404, not a 500", () => {
    const { req, res, next } = makeReqRes({ id: "not-an-object-id" });

    validateObjectIdParam()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it("rejects a missing id the same way", () => {
    const { req, res, next } = makeReqRes({});

    validateObjectIdParam()(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("checks whichever param name it's configured for, not just 'id'", () => {
    const { req, res, next } = makeReqRes({ parentId: "bad", id: "6a79f7298341f33d9a65b0b7" });

    validateObjectIdParam("parentId")(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});
