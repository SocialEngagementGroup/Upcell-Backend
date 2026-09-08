const { convertLineItems, toCents } = require("../src/utils/orderItems");

describe("toCents", () => {
  it("converts a clean dollar amount", () => {
    expect(toCents(10.5)).toBe(1050);
  });

  it("rounds away float drift instead of truncating it", () => {
    // 99.99 * 3 style drift, already baked into a stored dollar figure.
    expect(toCents(299.96999999999997)).toBe(29997);
  });

  it("treats a missing value as zero", () => {
    expect(toCents(undefined)).toBe(0);
  });
});

describe("convertLineItems", () => {
  // The exact order pasted in chat: 5x iPhone 17e + Priority Shipping,
  // real document from upcell_development (6a98342eac892f8de8ba9724).
  const realOrderLineItems = [
    {
      quantity: 5,
      price_data: {
        currency: "USD",
        unit_amount: 89900,
        product_data: {
          name: "iPhone 17e",
          description: "Black Excellent 256GB",
          images: ["/product-images/product-photos/iphone-17-iphone-17e-17-e-black-2244fc17af.png"],
          metadata: {
            productId: "6a271d2e72b1c0791a38e27d",
            quantity: 5,
            totalPaid: 4495,
          },
        },
      },
    },
    {
      quantity: 1,
      price_data: {
        currency: "USD",
        unit_amount: 1050,
        product_data: {
          name: "Priority Shipping",
          metadata: {
            totalPaid: 10.5,
          },
        },
      },
    },
  ];

  it("converts the real 5x iPhone 17e + Priority Shipping order correctly", () => {
    const result = convertLineItems(realOrderLineItems);

    expect(result.items).toEqual([
      {
        productId: "6a271d2e72b1c0791a38e27d",
        name: "iPhone 17e",
        description: "Black Excellent 256GB",
        image: "/product-images/product-photos/iphone-17-iphone-17e-17-e-black-2244fc17af.png",
        quantity: 5,
        unitPriceCents: 89900,
        lineTotalCents: 449500,
      },
    ]);
    expect(result.shippingCents).toBe(1050);
    expect(result.taxCents).toBe(0);
    expect(result.subtotalCents).toBe(449500);
    expect(result.totalCents).toBe(450550);
    expect(result.unrecognized).toEqual([]);
  });

  it("bucket tax and shipping separately, and sums a full checkout correctly", () => {
    const lineItems = [
      {
        quantity: 2,
        price_data: {
          product_data: {
            name: "iPhone Air",
            metadata: { productId: "p1", quantity: 2, totalPaid: 2198 },
          },
        },
      },
      {
        quantity: 1,
        price_data: { product_data: { name: "Sales tax", metadata: { totalPaid: 175.84 } } },
      },
      {
        quantity: 1,
        price_data: { product_data: { name: "Express Shipping", metadata: { totalPaid: 25 } } },
      },
    ];

    const result = convertLineItems(lineItems);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].lineTotalCents).toBe(219800);
    expect(result.items[0].unitPriceCents).toBe(109900);
    expect(result.taxCents).toBe(17584);
    expect(result.shippingCents).toBe(2500);
    expect(result.subtotalCents).toBe(219800);
    expect(result.totalCents).toBe(239884);
  });

  it("handles multiple distinct products in one order", () => {
    const lineItems = [
      {
        quantity: 2,
        price_data: { product_data: { name: "iPhone 17e", metadata: { productId: "a", quantity: 2, totalPaid: 2078 } } },
      },
      {
        quantity: 1,
        price_data: { product_data: { name: "Ultra-Glass Protector", metadata: { productId: "b", quantity: 1, totalPaid: 19 } } },
      },
      {
        quantity: 2,
        price_data: { product_data: { name: "iPhone 13 mini", metadata: { productId: "c", quantity: 2, totalPaid: 998 } } },
      },
    ];

    const result = convertLineItems(lineItems);

    expect(result.items).toHaveLength(3);
    expect(result.subtotalCents).toBe(207800 + 1900 + 99800);
  });

  it("flags an unrecognised fee line instead of silently folding it into shipping or tax", () => {
    const lineItems = [
      { quantity: 1, price_data: { product_data: { name: "Gift wrap", metadata: { totalPaid: 5 } } } },
    ];

    const result = convertLineItems(lineItems);

    expect(result.items).toEqual([]);
    expect(result.taxCents).toBe(0);
    expect(result.shippingCents).toBe(0);
    expect(result.unrecognized).toEqual([{ name: "Gift wrap", lineTotalCents: 500 }]);
  });

  it("returns all zeros for an order with no line items", () => {
    const result = convertLineItems([]);

    expect(result).toEqual({
      items: [],
      taxCents: 0,
      shippingCents: 0,
      subtotalCents: 0,
      totalCents: 0,
      unrecognized: [],
    });
  });

  it("handles a missing line_items array the same as an empty one", () => {
    expect(convertLineItems(undefined).totalCents).toBe(0);
  });

  it("derives unitPriceCents from the line total, not from unit_amount, so the two can never disagree", () => {
    // A deliberately "wrong" unit_amount (as if it had drifted) — the
    // conversion must still produce a self-consistent result derived only
    // from totalPaid, which is what every other part of the app has always
    // trusted.
    const lineItems = [
      {
        quantity: 3,
        price_data: {
          unit_amount: 1,
          product_data: { name: "Case", metadata: { productId: "x", quantity: 3, totalPaid: 29.97 } },
        },
      },
    ];

    const result = convertLineItems(lineItems);

    expect(result.items[0].lineTotalCents).toBe(2997);
    expect(result.items[0].unitPriceCents).toBe(999);
  });
});
