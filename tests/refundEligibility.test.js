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

  it("refuses once the window and the warranty have both run out", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      // Over a year after delivery.
      now: new Date("2027-10-05T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("window_closed");
    // Both dates are in the message so the customer is not left guessing
    // which of the two ran out.
    expect(result.message).toContain("return window for this order closed");
    expect(result.message).toContain("12-month warranty ended");
  });

  // Past 30 days is not automatically a no. The first year is covered, and a
  // device that is broken in month two is a claim UpCell says it will honour.
  it("becomes a warranty claim after the 30 days, for a hardware fault", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
      reasonCode: "WONT_POWER_ON",
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("WARRANTY");
  });

  it("stays a return inside the 30 days", () => {
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-09-10T00:00:00Z"),
      reasonCode: "CHANGED_MIND",
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("RETURN");
    // Nothing narrows the reasons while the return window is open.
    expect(result.reasonCodes).toBeNull();
  });

  it("refuses a change of mind in month two", () => {
    // Eight weeks is not a change of mind, it is a used phone.
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
      reasonCode: "CHANGED_MIND",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_warranty_reason");
  });

  it("does not demand a fault before the customer has picked one", () => {
    // This same function answers the page load, which happens before anything
    // has been chosen. Refusing here would put "choose a fault" above a form
    // the customer has not been given yet. Submitting without one is refused
    // by the controller, which is where the requirement belongs.
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("WARRANTY");
  });

  it("sends the shorter reason list with a warranty claim", () => {
    // So the form draws the reasons the server will accept, rather than
    // offering a customer one it is about to refuse.
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
      reasonCode: "BATTERY_ISSUE",
    });

    expect(result.reasonCodes).toContain("BATTERY_ISSUE");
    expect(result.reasonCodes).not.toContain("CHANGED_MIND");
  });

  it("tells the customer when the warranty ends, on both kinds", () => {
    const inWindow = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-09-10T00:00:00Z"),
      reasonCode: "CHANGED_MIND",
    });

    expect(inWindow.warrantyEndsAt).toEqual(new Date("2027-09-01T00:00:00Z"));
  });

  it("does not hold a transit-damage claim to three days in month two", () => {
    // That deadline is about telling a courier's dent from a kitchen-counter
    // dent, which is a question inside the return window and nowhere else.
    // The reason is refused for being outside the warranty, not for lateness.
    const result = checkReturnEligibility(deliveredOrder(), {
      now: new Date("2026-10-05T00:00:00Z"),
      reasonCode: "ARRIVED_DAMAGED_BOX",
    });

    expect(result.reason).toBe("not_a_warranty_reason");
    expect(result.reason).not.toBe("transit_claim_late");
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
