const { calculateRefund } = require("../src/services/refund");

// The refund is the goods plus the tax paid on them. Nothing is deducted.
//
//   Devices $2,198.00 + tax $175.84 = $2,373.84
//
// There is no restocking fee under any reason - the policy now matches Back
// Market, which is what UpCell's customers compare it against. Shipping stays
// out of it entirely, because UpCell bears that cost on a return.
//
// The tests below kept their reason codes even though the reason no longer
// changes the arithmetic. They document that it does not.
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

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.ok).toBe(true);
    expect(result.itemsTotal).toBe(2198);
    expect(result.restockingFee).toBe(0);
    expect(result.taxRefunded).toBe(175.84);
    expect(result.refundAmount).toBe(2373.84);
  });

  it("returns the whole tax on a full return, and never refunds shipping", () => {
    // Both lines carry no productId, which is the only thing that tells a
    // real device apart from tax or shipping in a flat line_items array. The
    // name is then what separates the two: one comes back, one does not.
    const order = {
      line_items: [deviceLine("p1", "iPhone 17", 999), taxLine(79.92), shippingLine(25)],
    };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.itemsTotal).toBe(999);
    expect(result.taxRefunded).toBe(79.92);
    expect(result.refundAmount).toBe(1078.92);
  });

  it("refunds nothing in tax on an order placed before UpCell charged any", () => {
    // Orders exist from the months when the site displayed tax and the backend
    // never charged it. Recalculating 8% would hand back money the customer
    // never paid.
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999), shippingLine(10.5)] };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.taxRefunded).toBe(0);
    expect(result.refundAmount).toBe(999);
  });

  it("hands back the goods and the tax paid on them, with nothing deducted", () => {
    // $1,000 of goods, $80 of tax. The customer gets $1,080 - there is no fee
    // on the goods and there never was one on the tax.
    const order = { line_items: [deviceLine("p1", "iPad", 1000), taxLine(80)] };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.restockingFee).toBe(0);
    expect(result.refundAmount).toBe(1080);
  });

  it("refunds only the items named, on a multi-item order", () => {
    const order = {
      line_items: [
        deviceLine("p1", "iPhone 17", 999),
        deviceLine("p2", "Clear Case", 39),
        taxLine(83.04),
      ],
    };

    const result = calculateRefund(order, { itemIds: ["p2"], reasonCode: "CHANGED_MIND" });

    expect(result.itemsTotal).toBe(39);
    expect(result.restockingFee).toBe(0);
    // Tax is shared out by price: $39 of $1,038 of goods, so $3.12 of the
    // $83.04 charged. The customer keeps the tax on the phone they kept.
    expect(result.taxRefunded).toBe(3.12);
    expect(result.refundAmount).toBe(42.12);
    expect(result.refundableItems).toHaveLength(1);
  });

  it("refunds every item when none are named", () => {
    const order = {
      line_items: [deviceLine("p1", "iPhone 17", 999), deviceLine("p2", "Clear Case", 39)],
    };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.itemsTotal).toBe(1038);
  });

  it("waives the fee only with a reason, and takes it at zero", () => {
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999)] };

    const waived = calculateRefund(order, { reasonCode: "CHANGED_MIND", waiveRestockingFee: true, waiveReason: "Confirmed faulty screen" });
    expect(waived.ok).toBe(true);
    expect(waived.restockingFee).toBe(0);
    expect(waived.restockingFeeWaived).toBe(true);
    expect(waived.refundAmount).toBe(999);

    const noReason = calculateRefund(order, { reasonCode: "CHANGED_MIND", waiveRestockingFee: true });
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("reason");
  });

  it("refuses a request naming no item on the order", () => {
    const order = { line_items: [deviceLine("p1", "iPhone 17", 999)] };

    const result = calculateRefund(order, { itemIds: ["does-not-exist"], reasonCode: "CHANGED_MIND" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No matching items");
  });

  it("refuses an order with nothing refundable — tax and shipping alone", () => {
    const order = { line_items: [taxLine(80), shippingLine(10)] };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.ok).toBe(false);
  });

  it("adds two quantities of the same device correctly", () => {
    // totalPaid on a line already reflects quantity (price x qty, set once at
    // checkout) - the calculation must not multiply it again.
    const order = { line_items: [deviceLine("p1", "iPhone 16", 1998, 2)] };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.itemsTotal).toBe(1998);
    expect(result.refundAmount).toBe(1998);
  });

  it("rounds the tax share to the cent, not to a third decimal", () => {
    // A figure a human types into a bank by hand cannot carry a fraction of a
    // cent. The fee used to be where this showed up; the tax share is now.
    const order = { line_items: [deviceLine("p1", "iPad", 33.33), taxLine(2.67)] };

    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.refundAmount).toBe(36);
    expect(Number.isInteger(Math.round(result.refundAmount * 100))).toBe(true);
  });

  it("never charges a restocking fee, whatever the reason", () => {
    // The rate constant is gone. This is what replaced it: the guarantee that
    // no reason code can put a deduction back.
    const order = { line_items: [deviceLine("p1", "iPad", 1000)] };

    for (const reasonCode of ["CHANGED_MIND", "WONT_POWER_ON", "OTHER", undefined]) {
      expect(calculateRefund(order, { reasonCode }).restockingFee).toBe(0);
    }
  });
});

describe("no reason code can put a deduction back", () => {
  const order = { line_items: [deviceLine("p1", "iPhone 15", 1000)] };

  it("charges nothing when the customer simply changed their mind", () => {
    // This is the policy reversal. It used to be 15%, and the reason it is not
    // any more is that free returns are what UpCell's customers compare it on.
    const result = calculateRefund(order, { reasonCode: "CHANGED_MIND" });

    expect(result.restockingFee).toBe(0);
    expect(result.refundAmount).toBe(1000);
  });

  it("charges nothing when the device would not power on", () => {
    const result = calculateRefund(order, { reasonCode: "WONT_POWER_ON" });

    expect(result.restockingFee).toBe(0);
    expect(result.refundAmount).toBe(1000);
  });

  it("charges nothing for every reason there is", () => {
    const {
      RETURN_REASON_CODES,
    } = require("../src/constants/returnReasons");

    for (const reasonCode of RETURN_REASON_CODES) {
      expect(calculateRefund(order, { reasonCode }).restockingFee).toBe(0);
    }
  });

  it("charges nothing when no reason was given at all", () => {
    expect(calculateRefund(order, {}).restockingFee).toBe(0);
  });

  it("still refuses to waive without a reason, so an older client cannot break", () => {
    const result = calculateRefund(order, { waiveRestockingFee: true });

    expect(result.ok).toBe(false);
  });
});
