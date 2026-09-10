process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/emailConfig.model");

const SingleVariation = require("../src/models/singleVariation.model");
const checkout = require("../src/controllers/checkout.controller");

const iphoneAir = {
  _id: "prod1",
  price: 1099,
  productName: "iPhone Air",
  color: { name: "Cloud White" },
  condition: "Mint",
  storage: "256GB",
  image: "/x.png",
};

const build = async (orders, shipping) => {
  SingleVariation.find.mockResolvedValue([iphoneAir]);
  return checkout.makeOrderObjAndTotal({
    req: { body: { orders, shipping } },
    paidWith: "BankOfAmerica",
  });
};

const lineNamed = (order, name) =>
  order.line_items.find((i) => i.price_data.product_data.name === name);

describe("sales tax is charged, not just displayed", () => {
  it("charges the exact total the website shows", async () => {
    // The real order from 3 September: 2 x iPhone Air at $1,099, express
    // shipping. The site displayed $2,398.84 and the bank was sent $2,223.00 —
    // the $175.84 tax was shown to the customer and never charged.
    const { order, totalPrice } = await build(["prod1", "prod1"], "express");

    expect(totalPrice).toBe(2398.84);

    const tax = lineNamed(order, "Sales tax");
    expect(tax.price_data.product_data.metadata.totalPaid).toBe(175.84);
  });

  it("taxes the goods only, never the shipping", async () => {
    const standard = await build(["prod1"], "standard");
    const express = await build(["prod1"], "express");

    const taxOf = (r) => lineNamed(r.order, "Sales tax").price_data.product_data.metadata.totalPaid;

    // $25 of express shipping must not add $2 of tax.
    expect(taxOf(standard)).toBe(taxOf(express));
    expect(taxOf(standard)).toBe(87.92);
  });

  it("rounds tax to whole cents", async () => {
    SingleVariation.find.mockResolvedValue([{ ...iphoneAir, price: 333.33 }]);
    const { order, totalPrice } = await checkout.makeOrderObjAndTotal({
      req: { body: { orders: ["prod1"], shipping: "standard" } },
      paidWith: "BankOfAmerica",
    });

    // 333.33 * 0.08 = 26.6664. A fraction of a cent reaching the bank would
    // fail the amount check on the confirmation.
    const tax = lineNamed(order, "Sales tax").price_data.product_data.metadata.totalPaid;
    expect(tax).toBe(26.67);
    expect(Number(totalPrice.toFixed(2))).toBe(totalPrice);
  });

  it("puts tax on the receipt as its own line", async () => {
    const { order } = await build(["prod1"], "priority");

    // The customer must be able to see what they were charged tax on, both in
    // the receipt email and in the admin order view.
    const names = order.line_items.map((i) => i.price_data.product_data.name);
    expect(names).toContain("iPhone Air");
    expect(names).toContain("Sales tax");
    expect(names).toContain("Priority Shipping");
  });

  it("keeps the order total and the receipt total in step", async () => {
    const { order, totalPrice } = await build(["prod1", "prod1"], "express");

    // orderTotal is what the bank's confirmation is checked against. If it
    // disagreed with totalPrice, every payment would be flagged as a mismatch.
    expect(checkout.orderTotal(order)).toBe(totalPrice);
  });
});

// The rate itself. It used to be a constant in the middle of the checkout
// controller, with three more copies hardcoded in the frontend.
describe("the sales tax service", () => {
  const { calculateTax, salesTaxRate } = require("../src/services/salesTax");

  const withRate = (value, fn) => {
    const saved = process.env.SALES_TAX_RATE;
    if (value === undefined) delete process.env.SALES_TAX_RATE;
    else process.env.SALES_TAX_RATE = String(value);
    try { fn(); } finally {
      if (saved === undefined) delete process.env.SALES_TAX_RATE;
      else process.env.SALES_TAX_RATE = saved;
    }
  };

  it("charges 8% on goods", () => {
    expect(calculateTax({ goodsCents: 100000 })).toEqual({ taxCents: 8000, rate: 0.08 });
  });

  it("charges the same wherever it ships", () => {
    // A deliberate simplification, not an oversight. UpCell has chosen one
    // rate everywhere; the accountant sign-off is X10 in PIPELINE.md.
    const ohio = calculateTax({ goodsCents: 100000, shipToState: "OH" });
    const texas = calculateTax({ goodsCents: 100000, shipToState: "TX" });
    const pickup = calculateTax({ goodsCents: 100000 });

    expect(ohio.taxCents).toBe(8000);
    expect(texas.taxCents).toBe(8000);
    expect(pickup.taxCents).toBe(8000);
  });

  it("taxes nothing when there are no goods", () => {
    // Shipping is never passed in, so it is never taxed. An order that is all
    // shipping has no goods and owes nothing.
    expect(calculateTax({ goodsCents: 0 }).taxCents).toBe(0);
    expect(calculateTax({}).taxCents).toBe(0);
    expect(calculateTax({ goodsCents: -100 }).taxCents).toBe(0);
  });

  it("reads the rate from the environment", () => {
    withRate(0.075, () => {
      expect(salesTaxRate()).toBe(0.075);
      expect(calculateTax({ goodsCents: 100000 }).taxCents).toBe(7500);
    });
  });

  it("falls back to 8% rather than to nothing", () => {
    // A rate of 0 because somebody fat-fingered a deploy is not a failure
    // anyone notices until an accountant does.
    for (const bad of [undefined, "", "abc", -1, 2]) {
      withRate(bad, () => expect(salesTaxRate()).toBe(0.08));
    }
  });

  it("reads the environment on every call, not once at import", () => {
    withRate(0.05, () => expect(salesTaxRate()).toBe(0.05));
    withRate(0.09, () => expect(salesTaxRate()).toBe(0.09));
  });

  it("rounds to the cent", () => {
    // 8% of $10.13 is 81.04 cents.
    expect(calculateTax({ goodsCents: 1013 }).taxCents).toBe(81);
    expect(calculateTax({ goodsCents: 1019 }).taxCents).toBe(82);
  });

  it("reports the rate it used, for storing on the order", () => {
    withRate(0.075, () => {
      expect(calculateTax({ goodsCents: 100000 }).rate).toBe(0.075);
    });
  });
});

describe("GET /tax-rate", () => {
  const orderController = require("../src/controllers/order.controller");

  it("tells the shop what rate to quote", () => {
    const res = {
      statusCode: null, body: null, headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
    };

    orderController.getTaxRate({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ rate: 0.08 });
    // The same number for everyone, and printed on every receipt anyway.
    expect(res.headers["Cache-Control"]).toMatch(/public/);
  });
});
