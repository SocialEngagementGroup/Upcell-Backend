const { calculateRefund, RESTOCKING_FEE_RATE } = require("../src/services/refund");

// Matches the worked example the client confirmed, as extended by their
// 9 Sep 2026 answer on tax:
//   Devices $2,198.00 − 15% ($329.70) + tax $175.84 = $2,044.14
// The fee is taken on the goods only and never on the tax; shipping stays
// out of it entirely, because UpCell bears that cost on a return.
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
    expect(result.taxRefunded).toBe(175.84);
    expect(result.refundAmount).toBe(2044.14);
  });

  it("returns the whole tax on a full return, and never refunds shipping", () => {
    // Both lines carry no productId, which is the only thing that tells a
    // real device apart from tax or shipping in a flat line_items array. The
    // name is then what separates the two: one comes back, one does not.
    const order = {
      line_items: [deviceLine("p1", "iPhone 17", 999), taxLine(79.92), shippingLine(25)],
    };

    const result = calculateRefund(order, {});

    expect(result.itemsTotal).toBe(999);
    expect(result.taxRefunded).toBe(79.92);
    expect(result.refundAmount).toBe(929.07);
  });

  it("refunds nothing in tax on an order placed before UpCell charged any", () => {
    // Orders exist from the months when the site displayed tax and the backend
    // never charged it. Recalculating 8% would hand back money the customer
    // never paid.
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999), shippingLine(10.5)] };

    const result = calculateRefund(order, {});

    expect(result.taxRefunded).toBe(0);
    expect(result.refundAmount).toBe(849.15);
  });

  it("takes the 15% on the goods only, never on the tax", () => {
    // $1,000 of goods, $80 of tax. The fee is $150, not $162.
    const order = { line_items: [deviceLine("p1", "iPad", 1000), taxLine(80)] };

    const result = calculateRefund(order, {});

    expect(result.restockingFee).toBe(150);
    expect(result.refundAmount).toBe(930);
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
    // Tax is shared out by price: $39 of $1,038 of goods, so $3.12 of the
    // $83.04 charged. The customer keeps the tax on the phone they kept.
    expect(result.taxRefunded).toBe(3.12);
    expect(result.refundAmount).toBe(36.27);
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
