const {
  productFilterSchema,
  wholesaleFormSchema,
  captureSchema,
  orderSchema,
} = require("../src/schemas/request.schemas");

describe("productFilterSchema (NoSQL injection fix — POST /products/:n/:skip)", () => {
  it("accepts well-formed filter input", () => {
    const result = productFilterSchema.parse({
      productName: ["iPhone 15"],
      storage: ["128GB"],
      color: ["Black"],
      condition: ["Mint"],
      price: [0, 2000],
    });
    expect(result.price).toEqual([0, 2000]);
  });

  it("fills in safe defaults when fields are omitted", () => {
    const result = productFilterSchema.parse({});
    expect(result.productName).toEqual([]);
    expect(result.price).toEqual([0, Number.MAX_SAFE_INTEGER]);
  });

  it("rejects a crafted object in place of the price array (the actual injection vector found)", () => {
    // Before the fix, price[0]/price[1] were indexed into directly — an
    // object like this would have flowed straight into a Mongo $gte/$lte.
    expect(() =>
      productFilterSchema.parse({ price: { 0: { $ne: null }, 1: { $ne: null } } })
    ).toThrow();
  });

  it("rejects an operator object in place of productName", () => {
    expect(() => productFilterSchema.parse({ productName: { $ne: null } })).toThrow();
  });

  it("rejects a non-array condition field", () => {
    expect(() => productFilterSchema.parse({ condition: "Mint" })).toThrow();
  });
});

describe("wholesaleFormSchema (mass-assignment fix)", () => {
  it("accepts a normal submission", () => {
    const result = wholesaleFormSchema.parse({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "1234567890",
      devices: "50x iPhone 13",
    });
    expect(result).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "1234567890",
      devices: "50x iPhone 13",
    });
  });

  it("strips fields not in the schema instead of passing them through to the DB write", () => {
    const result = wholesaleFormSchema.parse({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "1234567890",
      devices: "50x iPhone 13",
      role: "admin", // attempted mass-assignment
      paid: true,
    });
    expect(result.role).toBeUndefined();
    expect(result.paid).toBeUndefined();
  });

  it("rejects an invalid email", () => {
    expect(() =>
      wholesaleFormSchema.parse({ name: "Jane", email: "not-an-email", phone: "123", devices: "x" })
    ).toThrow();
  });
});

describe("captureSchema (PayPal order id validation)", () => {
  it("accepts a realistic PayPal order id", () => {
    expect(captureSchema.parse({ orderID: "8U481631H66031715" }).orderID).toBe("8U481631H66031715");
  });

  it("rejects an object payload (NoSQL injection attempt via orderID)", () => {
    expect(() => captureSchema.parse({ orderID: { $ne: null } })).toThrow();
  });

  it("rejects a garbage/oversized string", () => {
    expect(() => captureSchema.parse({ orderID: "a".repeat(200) })).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => captureSchema.parse({ orderID: "" })).toThrow();
  });
});

describe("orderSchema.idempotencyKey", () => {
  const base = {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "1234567890",
    city: "City",
    postal: "12345",
    street: "123 Some Street",
    country: "US",
    orders: ["507f1f77bcf86cd799439011"],
  };

  it("is optional (Manual checkout doesn't send one)", () => {
    expect(() => orderSchema.parse(base)).not.toThrow();
  });

  it("is carried through when present", () => {
    const result = orderSchema.parse({ ...base, idempotencyKey: "abc-123" });
    expect(result.idempotencyKey).toBe("abc-123");
  });
});
