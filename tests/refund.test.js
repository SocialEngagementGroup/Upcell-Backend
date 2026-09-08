const { calculateRefund, RESTOCKING_FEE_RATE } = require("../src/services/refund");

// Matches the worked example the client confirmed:
//   Devices $2,198.00 − 15% ($329.70) = $1,868.30
// That example never mentions tax, so this test data omits it too — the
// calculation is built strictly to what was confirmed, not what seems logical.
const deviceLine = (productId, name, totalPaid, quantity = 1) => ({
  quantity,
  price_data: {
    product_data: {
      name,
      metadata: { productId, quantity, totalPaid },
    },
  },
});

const taxLine = (totalPaid) => ({
  quantity: 1,
  price_data: { product_data: { name: "Sales tax", metadata: { totalPaid } } },
});

const shippingLine = (totalPaid) => ({
  quantity: 1,
  price_data: { product_data: { name: "Priority Shipping", metadata: { totalPaid } } },
});

describe("calculateRefund — the client's confirmed rule, exactly", () => {
  it("matches the client's own worked example", () => {
    const order = {
      line_items: [
        deviceLine("p1", "MacBook Pro", 2198),
        taxLine(175.84),
        shippingLine(10.5),
      ],
    };

    const result = calculateRefund(order, {});

    expect(result.ok).toBe(true);
    expect(result.itemsTotal).toBe(2198);
    expect(result.restockingFee).toBe(329.7);
    expect(result.refundAmount).toBe(1868.3);
  });

  it("never touches the tax or shipping lines", () => {
    // Both lines carry no productId, which is the only thing that tells a
    // real device apart from tax or shipping in a flat line_items array.
    const order = {
      line_items: [deviceLine("p1", "iPhone 17", 999), taxLine(79.92), shippingLine(25)],
    };

    const result = calculateRefund(order, {});

    expect(result.itemsTotal).toBe(999);
    expect(result.refundAmount).toBe(849.15);
  });

  it("refunds only the items named, on a multi-item order", () => {
    const order = {
      line_items: [
        deviceLine("p1", "iPhone 17", 999),
        deviceLine("p2", "Clear Case", 39),
        taxLine(83.04),
      ],
    };

    const result = calculateRefund(order, { itemIds: ["p2"] });

    expect(result.itemsTotal).toBe(39);
    expect(result.restockingFee).toBe(5.85);
    expect(result.refundAmount).toBe(33.15);
    expect(result.refundableItems).toHaveLength(1);
  });

  it("refunds every item when none are named", () => {
    const order = {
      line_items: [deviceLine("p1", "iPhone 17", 999), deviceLine("p2", "Clear Case", 39)],
    };

    const result = calculateRefund(order, {});

    expect(result.itemsTotal).toBe(1038);
  });

  it("waives the fee only with a reason, and takes it at zero", () => {
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999)] };

    const waived = calculateRefund(order, { waiveRestockingFee: true, waiveReason: "Confirmed faulty screen" });
    expect(waived.ok).toBe(true);
    expect(waived.restockingFee).toBe(0);
    expect(waived.restockingFeeWaived).toBe(true);
    expect(waived.refundAmount).toBe(999);

    const noReason = calculateRefund(order, { waiveRestockingFee: true });
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("reason");
  });

  it("refuses a request naming no item on the order", () => {
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999)] };

    const result = calculateRefund(order, { itemIds: ["does-not-exist"] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No matching items");
  });

  it("refuses an order with nothing refundable — tax and shipping alone", () => {
    const order = { line_items: [taxLine(80), shippingLine(10)] };

    const result = calculateRefund(order, {});

    expect(result.ok).toBe(false);
  });

  it("adds two quantities of the same device correctly before taking the fee", () => {
    // totalPaid on a line already reflects quantity (price × qty, set once at
    // checkout) — the calculation must not multiply it again.
    const order = { line_items: [deviceLine("p1", "iPhone 16", 1998, 2)] };

    const result = calculateRefund(order, {});

    expect(result.itemsTotal).toBe(1998);
    expect(result.restockingFee).toBe(299.7);
  });

  it("rounds to the cent on a figure that does not divide evenly", () => {
    // 33.33 * 0.15 = 4.9995 — must round to a real number of cents, not carry
    // a third decimal into a dollar figure a human has to type by hand.
    const result = calculateRefund({ line_items: [deviceLine("p1", "iPad", 33.33)] }, {});

    expect(result.restockingFee).toBe(5);
    expect(result.refundAmount).toBe(28.33);
  });

  it("15% is the actual rate constant, not a copy of it", () => {
    expect(RESTOCKING_FEE_RATE).toBe(0.15);
  });
});
