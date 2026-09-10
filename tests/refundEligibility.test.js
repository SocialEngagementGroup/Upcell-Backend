const {
  RETURN_WINDOW_DAYS,
  returnWindowClosesAt,
  checkReturnEligibility,
  checkSelectedItems,
} = require("../src/services/refundEligibility");

const DAY_MS = 24 * 60 * 60 * 1000;

const deviceLine = (productId, name = "iPhone 15", totalPaid = 999) => ({
  quantity: 1,
  price_data: { product_data: { name, metadata: { productId, quantity: 1, totalPaid } } },
});

// Tax and shipping rows carry no productId, which is what marks them
// unreturnable.
const feeLine = (name) => ({
  quantity: 1,
  price_data: { product_data: { name, metadata: { totalPaid: 10.5 } } },
});

const deliveredOrder = (overrides = {}) => ({
  paid: true,
  deliveredAt: new Date("2026-09-01T00:00:00Z"),
  line_items: [deviceLine("p1"), deviceLine("p2", "iPad Air", 599), feeLine("Shipping")],
  ...overrides,
});

describe("returnWindowClosesAt — counted from delivery, not from the order date", () => {
  it("closes 30 days after the device arrived", () => {
    const order = deliveredOrder();
    const closes = returnWindowClosesAt(order);

    expect(closes.getTime() - new Date(order.deliveredAt).getTime()).toBe(
      30 * DAY_MS
    );
  });

  // An order placed on the 1st and delivered on the 10th must give the customer
  // 30 days from the 10th. Counting from createdAt would silently take nine
  // days off their window.
  it("ignores when the order was placed", () => {
    const closes = returnWindowClosesAt(
      deliveredOrder({ createdAt: new Date("2026-08-01T00:00:00Z") })
    );

    expect(closes.toISOString()).toBe(new Date("2026-10-01T00:00:00Z").toISOString());
  });

  it("has no closing date until the order is delivered", () => {
    expect(returnWindowClosesAt(deliveredOrder({ deliveredAt: undefined }))).toBeNull();
  });
});

describe("checkReturnEligibility", () => {
  it("accepts a paid, delivered order inside the window", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-09-15T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    // The shipping row is not offered back to the customer.
    expect(result.items).toHaveLength(2);
  });

  it("accepts on the last day of the window", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-09-30T23:59:00Z"),
    });

    expect(result.ok).toBe(true);
  });

  it("refuses once the window has closed", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("window_closed");
    // The date is in the message so the customer is not left guessing.
    expect(result.message).toContain("2026");
  });

  // Not the same as an expired window: the customer has done nothing wrong and
  // simply has to wait, so the message says so.
  it("separates 'not delivered yet' from 'too late'", () => {
    const result = checkReturnEligibility(deliveredOrder({ deliveredAt: undefined }), {
      now: new Date("2026-09-15T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_delivered");
  });

  it("refuses an order that was never paid", () => {
    const result = checkReturnEligibility(deliveredOrder({ paid: false }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_paid");
  });

  it("refuses an order that has already been refunded", () => {
    const result = checkReturnEligibility(
      deliveredOrder({ refund: { approvedAt: new Date() } }),
      { now: new Date("2026-09-15T00:00:00Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_refunded");
  });

  it("refuses an order of nothing but tax and shipping", () => {
    const result = checkReturnEligibility(
      deliveredOrder({ line_items: [feeLine("Shipping"), feeLine("Sales tax")] }),
      { now: new Date("2026-09-15T00:00:00Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("nothing_returnable");
  });
});

describe("checkSelectedItems — what the customer chose must be on the order", () => {
  it("accepts items that are on the order", () => {
    const result = checkSelectedItems(deliveredOrder(), ["p1"]);

    expect(result.ok).toBe(true);
    expect(result.itemIds).toEqual(["p1"]);
  });

  it("collapses a duplicate selection", () => {
    const result = checkSelectedItems(deliveredOrder(), ["p1", "p1", "p2"]);

    expect(result.itemIds).toEqual(["p1", "p2"]);
  });

  // Without this an id from someone else's order would be accepted, and
  // calculateRefund would later find no matching line and refund nothing —
  // which reads as a system fault rather than a bad request.
  it("refuses an id that is not on this order", () => {
    const result = checkSelectedItems(deliveredOrder(), ["p1", "someone-elses-id"]);

    expect(result.ok).toBe(false);
  });

  it("refuses an empty selection", () => {
    expect(checkSelectedItems(deliveredOrder(), []).ok).toBe(false);
  });

  it("refuses the shipping row, which has no productId", () => {
    const result = checkSelectedItems(deliveredOrder(), ["Shipping"]);

    expect(result.ok).toBe(false);
  });
});
