const {
  productFilterSchema,
  wholesaleFormSchema,
  orderSchema,
  categorySchema,
  productSchema,
  productCreateSchema,
  tradeInRequestSchema,
  newsletterSubscriberSchema,
  contactSubmissionSchema,
  analyticsEventSchema,
  monthlySellSchema,
  cartLookupSchema,
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

  it("defaults shipping to 'standard' when omitted", () => {
    expect(orderSchema.parse(base).shipping).toBe("standard");
  });

  it("accepts an explicit shipping tier", () => {
    expect(orderSchema.parse({ ...base, shipping: "express" }).shipping).toBe("express");
  });

  it("rejects a shipping tier outside the enum", () => {
    expect(() => orderSchema.parse({ ...base, shipping: "overnight-drone" })).toThrow();
  });

  it("rejects an orders array longer than a real cart could be", () => {
    // One entry per unit on a public endpoint that drives a Mongo $in and a
    // per-id scan — without a ceiling a single request can carry hundreds of
    // thousands of ids.
    const tooMany = Array(101).fill("507f1f77bcf86cd799439011");
    expect(() => orderSchema.parse({ ...base, orders: tooMany })).toThrow();
    expect(() =>
      orderSchema.parse({ ...base, orders: tooMany.slice(0, 100) })
    ).not.toThrow();
  });

  it("rejects an empty orders array — a checkout needs at least one item", () => {
    expect(() => orderSchema.parse({ ...base, orders: [] })).toThrow();
  });

  it("paidWith is optional (not every caller of orderSchema knows it yet at validation time)", () => {
    expect(() => orderSchema.parse(base)).not.toThrow();
  });
});

describe("orderSchema.country — US-only shipping", () => {
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

  it.each([
    "US",
    "us",
    "USA",
    "U.S.",
    "U.S.A.",
    "United States",
    "united states of america",
    "  United   States  ",
  ])("accepts %j and normalises it to 'United States'", (country) => {
    expect(orderSchema.parse({ ...base, country }).country).toBe("United States");
  });

  it.each(["Canada", "United Kingdom", "Mexico", "Germany", "United Statesx"])(
    "rejects %j — we do not ship internationally",
    (country) => {
      expect(() => orderSchema.parse({ ...base, country })).toThrow(
        /United States only/
      );
    }
  );

  it("still rejects a missing country", () => {
    const { country, ...rest } = base;
    expect(() => orderSchema.parse(rest)).toThrow();
  });
});

describe("productFilterSchema — partial input (mix of provided and omitted fields)", () => {
  it("accepts productName provided with everything else defaulted", () => {
    const result = productFilterSchema.parse({ productName: ["iPhone 15"] });
    expect(result.productName).toEqual(["iPhone 15"]);
    expect(result.storage).toEqual([]);
    expect(result.price).toEqual([0, Number.MAX_SAFE_INTEGER]);
  });

  it("accepts a price range provided with everything else defaulted", () => {
    const result = productFilterSchema.parse({ price: [500, 1500] });
    expect(result.price).toEqual([500, 1500]);
    expect(result.productName).toEqual([]);
  });
});

describe("wholesaleFormSchema — remaining validation branches", () => {
  it("rejects a phone number that's too short to be real", () => {
    expect(() =>
      wholesaleFormSchema.parse({ name: "Jane", email: "jane@example.com", phone: "12", devices: "50x iPhone" })
    ).toThrow();
  });

  it("rejects a devices description over 500 characters", () => {
    expect(() =>
      wholesaleFormSchema.parse({
        name: "Jane",
        email: "jane@example.com",
        phone: "1234567890",
        devices: "x".repeat(501),
      })
    ).toThrow();
  });

  it("accepts a devices description right at the 500-character boundary", () => {
    expect(() =>
      wholesaleFormSchema.parse({
        name: "Jane",
        email: "jane@example.com",
        phone: "1234567890",
        devices: "x".repeat(500),
      })
    ).not.toThrow();
  });
});

describe("orderSchema — missing fields, wrong types, injection shapes", () => {
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

  it("rejects a payload missing every field", () => {
    expect(() => orderSchema.parse({})).toThrow();
  });

  it.each(["name", "email", "phone", "city", "postal", "street", "country", "orders"])(
    "rejects when required field '%s' is missing",
    (field) => {
      const { [field]: _omit, ...rest } = base;
      expect(() => orderSchema.parse(rest)).toThrow();
    }
  );

  it("rejects a numeric name (wrong type)", () => {
    expect(() => orderSchema.parse({ ...base, name: 12345 })).toThrow();
  });

  it("rejects an empty string for a required field", () => {
    expect(() => orderSchema.parse({ ...base, street: "" })).toThrow();
  });

  it("rejects a street below the 5-character minimum (boundary)", () => {
    expect(() => orderSchema.parse({ ...base, street: "1234" })).toThrow();
  });

  it("accepts a street at exactly the 5-character minimum (boundary)", () => {
    expect(() => orderSchema.parse({ ...base, street: "12345" })).not.toThrow();
  });

  it("rejects a NoSQL operator object in place of the orders array", () => {
    expect(() => orderSchema.parse({ ...base, orders: { $ne: null } })).toThrow();
  });

  it("rejects a NoSQL operator object standing in for a single order id", () => {
    expect(() => orderSchema.parse({ ...base, orders: [{ $gt: "" }] })).toThrow();
  });

  it("rejects an order id that isn't a valid 24-char hex ObjectId", () => {
    expect(() => orderSchema.parse({ ...base, orders: ["not-an-object-id"] })).toThrow();
  });

  it("rejects an operator object standing in for email (injection attempt)", () => {
    expect(() => orderSchema.parse({ ...base, email: { $ne: null } })).toThrow();
  });

  it("rejects an unexpected nested object where a plain string is expected", () => {
    expect(() => orderSchema.parse({ ...base, name: { first: "Jane", last: "Doe" } })).toThrow();
  });

  it("rejects paidWith outside the allowed enum (invalid payment data)", () => {
    expect(() => orderSchema.parse({ ...base, paidWith: "Cash" })).toThrow();
  });

  // The full accepted set. Stripe and Paypal were dropped with their gateways;
  // BankOfAmerica is the live one and belongs here explicitly, so a future edit
  // to the enum cannot quietly stop accepting the only gateway that works.
  it.each(["BankOfAmerica", "Card", "Manual"])(
    "accepts paidWith value '%s'",
    (paidWith) => {
      expect(() => orderSchema.parse({ ...base, paidWith })).not.toThrow();
    }
  );

  it.each(["Stripe", "Paypal"])(
    "rejects retired gateway '%s'",
    (paidWith) => {
      expect(() => orderSchema.parse({ ...base, paidWith })).toThrow();
    }
  );

  it("rejects an idempotencyKey over the 100-character limit", () => {
    expect(() => orderSchema.parse({ ...base, idempotencyKey: "x".repeat(101) })).toThrow();
  });
});

describe("productSchema — numeric coercion, refinements, nested objects, enums", () => {
  const base = {
    parentCatagory: "507f1f77bcf86cd799439011",
    productName: "iPhone 15",
    storage: "128GB",
    color: { name: "Black" },
    price: 999,
    condition: "Mint",
    image: "https://example.com/image.png",
  };

  it("accepts a well-formed product", () => {
    expect(() => productSchema.parse(base)).not.toThrow();
  });

  it("rejects a missing required nested color object", () => {
    const { color: _omit, ...rest } = base;
    expect(() => productSchema.parse(rest)).toThrow();
  });

  it("rejects a color object missing its required 'name' field (nested validation)", () => {
    expect(() => productSchema.parse({ ...base, color: { value: "#000000" } })).toThrow();
  });

  it("accepts a color object with only the required name field", () => {
    expect(() => productSchema.parse({ ...base, color: { name: "Black" } })).not.toThrow();
  });

  it("rejects price of zero (refine: must be > 0, not just non-negative)", () => {
    expect(() => productSchema.parse({ ...base, price: 0 })).toThrow();
  });

  it("rejects a negative price", () => {
    expect(() => productSchema.parse({ ...base, price: -50 })).toThrow();
  });

  it("coerces a numeric-looking string price (form input) to a number", () => {
    const result = productSchema.parse({ ...base, price: "999" });
    expect(result.price).toBe(999);
  });

  it("rejects a non-numeric string price (incorrect data type)", () => {
    expect(() => productSchema.parse({ ...base, price: "not-a-number" })).toThrow();
  });

  it("treats an empty-string optional numeric field (discountPrice) as omitted", () => {
    const result = productSchema.parse({ ...base, discountPrice: "" });
    expect(result.discountPrice).toBeUndefined();
  });

  it("coerces a real value provided for an optional numeric field (discountPrice)", () => {
    const result = productSchema.parse({ ...base, discountPrice: "799" });
    expect(result.discountPrice).toBe(799);
  });

  it("rejects a condition outside the enum", () => {
    expect(() => productSchema.parse({ ...base, condition: "Broken" })).toThrow();
  });

  it("rejects a malformed parentCatagory id (not 24-char hex)", () => {
    expect(() => productSchema.parse({ ...base, parentCatagory: "123" })).toThrow();
  });

  it("rejects a NoSQL operator object standing in for productName", () => {
    expect(() => productSchema.parse({ ...base, productName: { $ne: null } })).toThrow();
  });
});

describe("productCreateSchema — union of single product vs batch, nested variants array", () => {
  it("accepts a single-product payload (matches productSchema branch of the union)", () => {
    expect(() =>
      productCreateSchema.parse({
        parentCatagory: "507f1f77bcf86cd799439011",
        productName: "iPhone 15",
        storage: "128GB",
        color: { name: "Black" },
        price: 999,
        condition: "Mint",
        image: "https://example.com/image.png",
      })
    ).not.toThrow();
  });

  it("accepts a batch payload with nested variants (matches productBatchSchema branch)", () => {
    expect(() =>
      productCreateSchema.parse({
        productName: "iPhone 15",
        categoryName: "Phones",
        image: "https://example.com/image.png",
        variants: [
          { storage: "128GB", color: { name: "Black" }, price: 999 },
          { storage: "256GB", color: { name: "White" }, price: 1099 },
        ],
      })
    ).not.toThrow();
  });

  it("rejects a batch payload with an empty variants array (min 1 required)", () => {
    expect(() =>
      productCreateSchema.parse({
        productName: "iPhone 15",
        categoryName: "Phones",
        image: "https://example.com/image.png",
        variants: [],
      })
    ).toThrow();
  });

  it("rejects a batch payload where a nested variant is missing its required price", () => {
    expect(() =>
      productCreateSchema.parse({
        productName: "iPhone 15",
        categoryName: "Phones",
        image: "https://example.com/image.png",
        variants: [{ storage: "128GB", color: { name: "Black" } }],
      })
    ).toThrow();
  });

  it("rejects a payload matching neither branch of the union", () => {
    expect(() => productCreateSchema.parse({ nonsense: true })).toThrow();
  });
});

describe("categorySchema — missing/empty/boundary/injection cases", () => {
  it("rejects a missing modelName", () => {
    expect(() => categorySchema.parse({})).toThrow();
  });

  it("rejects an empty-string modelName", () => {
    expect(() => categorySchema.parse({ modelName: "" })).toThrow();
  });

  it("rejects a modelName over the 120-character limit", () => {
    expect(() => categorySchema.parse({ modelName: "x".repeat(121) })).toThrow();
  });

  it("accepts a modelName at exactly the 120-character boundary", () => {
    expect(() => categorySchema.parse({ modelName: "x".repeat(120) })).not.toThrow();
  });

  it("defaults images to an empty array when omitted", () => {
    expect(categorySchema.parse({ modelName: "Phones" }).images).toEqual([]);
  });

  it("rejects a NoSQL operator object standing in for modelName", () => {
    expect(() => categorySchema.parse({ modelName: { $ne: null } })).toThrow();
  });
});

describe("tradeInRequestSchema — numeric estimate, nested answers, injection shapes", () => {
  const base = {
    device: "iPhone",
    model: "iPhone 13",
    modelTitle: "iPhone 13 (128GB)",
    storage: "128GB",
    estimate: 350,
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "1234567890",
  };

  it("accepts a well-formed trade-in request", () => {
    expect(() => tradeInRequestSchema.parse(base)).not.toThrow();
  });

  it("rejects a negative estimate", () => {
    expect(() => tradeInRequestSchema.parse({ ...base, estimate: -10 })).toThrow();
  });

  it("accepts an estimate of exactly zero (boundary — refine allows >= 0)", () => {
    expect(() => tradeInRequestSchema.parse({ ...base, estimate: 0 })).not.toThrow();
  });

  it("rejects a non-numeric estimate (incorrect data type)", () => {
    expect(() => tradeInRequestSchema.parse({ ...base, estimate: "free" })).toThrow();
  });

  it("defaults answers to an empty object when omitted", () => {
    expect(tradeInRequestSchema.parse(base).answers).toEqual({});
  });

  it("accepts an arbitrary nested answers object (record type)", () => {
    const result = tradeInRequestSchema.parse({
      ...base,
      answers: { screenCondition: "Cracked", powersOn: true, notes: { detail: "corner chip" } },
    });
    expect(result.answers.powersOn).toBe(true);
  });

  it("rejects a missing required email", () => {
    const { email: _omit, ...rest } = base;
    expect(() => tradeInRequestSchema.parse(rest)).toThrow();
  });

  it("rejects an operator object standing in for phone (injection attempt)", () => {
    expect(() => tradeInRequestSchema.parse({ ...base, phone: { $ne: null } })).toThrow();
  });
});

describe("newsletterSubscriberSchema — missing/invalid email, optional source", () => {
  it("accepts an email with no source", () => {
    expect(() => newsletterSubscriberSchema.parse({ email: "jane@example.com" })).not.toThrow();
  });

  it("rejects a missing email", () => {
    expect(() => newsletterSubscriberSchema.parse({})).toThrow();
  });

  it("rejects a malformed email", () => {
    expect(() => newsletterSubscriberSchema.parse({ email: "not-an-email" })).toThrow();
  });

  it("rejects a source over the 80-character limit", () => {
    expect(() =>
      newsletterSubscriberSchema.parse({ email: "jane@example.com", source: "x".repeat(81) })
    ).toThrow();
  });

  it("rejects an operator object standing in for email (injection attempt)", () => {
    expect(() => newsletterSubscriberSchema.parse({ email: { $ne: null } })).toThrow();
  });
});

describe("contactSubmissionSchema — boundaries on subject/message length", () => {
  const base = { name: "Jane Doe", email: "jane@example.com", subject: "Question", message: "Hello there, I have a question." };

  it("accepts a well-formed submission", () => {
    expect(() => contactSubmissionSchema.parse(base)).not.toThrow();
  });

  it("rejects a subject below the 4-character minimum", () => {
    expect(() => contactSubmissionSchema.parse({ ...base, subject: "Hi" })).toThrow();
  });

  it("rejects a message below the 10-character minimum", () => {
    expect(() => contactSubmissionSchema.parse({ ...base, message: "too short" })).toThrow();
  });

  it("rejects a message over the 3000-character limit", () => {
    expect(() => contactSubmissionSchema.parse({ ...base, message: "x".repeat(3001) })).toThrow();
  });

  it("accepts a message at exactly the 3000-character boundary", () => {
    expect(() => contactSubmissionSchema.parse({ ...base, message: "x".repeat(3000) })).not.toThrow();
  });

  it("rejects a missing name", () => {
    const { name: _omit, ...rest } = base;
    expect(() => contactSubmissionSchema.parse(rest)).toThrow();
  });
});

describe("analyticsEventSchema — enums and nested metadata record", () => {
  const base = { category: "form_submit", name: "checkout_started" };

  it("accepts a minimal valid event", () => {
    expect(() => analyticsEventSchema.parse(base)).not.toThrow();
  });

  it("rejects a category outside the enum", () => {
    expect(() => analyticsEventSchema.parse({ ...base, category: "made_up_category" })).toThrow();
  });

  it.each(["started", "success", "failed", "dropoff", "error"])("accepts status value '%s'", (status) => {
    expect(() => analyticsEventSchema.parse({ ...base, status })).not.toThrow();
  });

  it("rejects a status outside the enum", () => {
    expect(() => analyticsEventSchema.parse({ ...base, status: "maybe" })).toThrow();
  });

  it("defaults metadata to an empty object when omitted", () => {
    expect(analyticsEventSchema.parse(base).metadata).toEqual({});
  });

  it("accepts an arbitrary nested metadata object (record type)", () => {
    const result = analyticsEventSchema.parse({
      ...base,
      metadata: { attempt: 2, context: { browser: "Chrome", nested: { deep: true } } },
    });
    expect(result.metadata.attempt).toBe(2);
  });

  it("rejects a message over the 1000-character limit", () => {
    expect(() => analyticsEventSchema.parse({ ...base, message: "x".repeat(1001) })).toThrow();
  });

  it("rejects a missing required name", () => {
    const { name: _omit, ...rest } = base;
    expect(() => analyticsEventSchema.parse(rest)).toThrow();
  });
});

describe("monthlySellSchema (NoSQL injection fix — POST /monthly-sell)", () => {
  it("accepts a well-formed name and amount", () => {
    const result = monthlySellSchema.parse({ name: "gt-sells", amount: 1234.5 });
    expect(result).toEqual({ name: "gt-sells", amount: 1234.5 });
  });

  it("rejects an operator object in place of name (the actual injection vector)", () => {
    // Before the fix, name went straight into MonthlySell.findOne({ name }) —
    // an object like this would have been interpreted as a query operator.
    expect(() => monthlySellSchema.parse({ name: { $ne: null }, amount: 1 })).toThrow();
  });

  it("rejects a non-numeric amount", () => {
    expect(() => monthlySellSchema.parse({ name: "gt-sells", amount: "not a number" })).toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => monthlySellSchema.parse({ name: "   ", amount: 1 })).toThrow();
  });
});

describe("cartLookupSchema (POST /cart)", () => {
  it("accepts a list of well-formed product ids", () => {
    const result = cartLookupSchema.parse({ ids: ["6a79f7298341f33d9a65b0b7"] });
    expect(result.ids).toEqual(["6a79f7298341f33d9a65b0b7"]);
  });

  it("defaults to an empty list when ids is omitted", () => {
    expect(cartLookupSchema.parse({}).ids).toEqual([]);
  });

  it("rejects a malformed id instead of letting it reach Mongo as a bad $in entry", () => {
    expect(() => cartLookupSchema.parse({ ids: ["not-an-object-id"] })).toThrow();
  });

  it("rejects ids that isn't an array at all", () => {
    // The original bug: a non-array ids throws an unhandled CastError deep in
    // the driver, which the global handler turns into a 500.
    expect(() => cartLookupSchema.parse({ ids: { $ne: null } })).toThrow();
  });
});
