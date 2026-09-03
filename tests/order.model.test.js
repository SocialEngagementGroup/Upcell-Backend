// Schema introspection only — no live database needed, and none of this
// touches the shared Mongoose connection other test files rely on.
const Order = require("../src/models/order.model");

describe("Order schema — boaTransactionId uniqueness", () => {
  it("is uniquely indexed, sparse so orders with no bank transaction don't collide", () => {
    const indexes = Order.schema.indexes();
    const match = indexes.find(([keys]) => Object.keys(keys).join() === "boaTransactionId");

    // Without this, the atomic claim in merchantPost only guarantees one
    // writer wins per order — nothing at the database level stops the same
    // bank transaction id from being recorded against two different orders.
    expect(match).toBeDefined();
    const [, options] = match;
    expect(options.unique).toBe(true);
    expect(options.sparse).toBe(true);
  });
});

describe("Order schema — amount and decision fields", () => {
  it("has the fields merchantPost needs to record what the bank actually decided", () => {
    const paths = Order.schema.paths;

    expect(paths.signedAmount).toBeDefined();
    expect(paths.authorizedAmount).toBeDefined();
    expect(paths.authorizedAt).toBeDefined();
    expect(paths.capturedAt).toBeDefined();
    expect(paths.boaDecision).toBeDefined();
    expect(paths.reasonCode).toBeDefined();
    expect(paths.avsResult).toBeDefined();
    expect(paths.cvnResult).toBeDefined();
  });

  it("defaults currency to USD without every caller having to say so", () => {
    const order = new Order({});
    expect(order.currency).toBe("USD");
  });
});
