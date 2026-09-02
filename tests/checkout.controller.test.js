// Env vars must be set before the controller is required — the Resend client
// and the admin address are read at module load.
process.env.RESEND_KEY = "test-resend-key";
process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";
process.env.EMAIL_FROM = "noreply@example.com";

const mockSend = jest.fn().mockResolvedValue({});
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

jest.mock("../src/models/order.model");
jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/emailConfig.model");

const Order = require("../src/models/order.model");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const SingleVariation = require("../src/models/singleVariation.model");
const { EmailConfig } = require("../src/models/emailConfig.model");
const checkout = require("../src/controllers/checkout.controller");

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  PaymentEventLog.create.mockResolvedValue({});
  // Customer emails on by default — individual tests flip this to assert the
  // Admin > Email Settings switch actually suppresses the receipt.
  EmailConfig.findOne.mockReturnValue({
    lean: () => Promise.resolve({ enableCustomerEmails: true }),
  });
});

describe("sendPaymentReceiptEmail — failure path", () => {
  it("logs but does not throw when the receipt email fails to send", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockSend.mockRejectedValueOnce(new Error("Resend is down"));

    checkout.sendPaymentReceiptEmail({
      _id: "order1",
      email: "buyer@example.com",
      paidWith: "BankOfAmerica",
      line_items: [],
    });
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to send payment receipt email:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

describe("logPaymentEvent — failure path", () => {
  it("logs but does not throw when PaymentEventLog.create rejects", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    PaymentEventLog.create.mockRejectedValueOnce(new Error("Mongo is down"));

    checkout.logPaymentEvent({ gateway: "BankOfAmerica", eventType: "webhook_received" });
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[payment-event-log] failed to write:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

describe("sendPaymentReceiptEmail — customer email switch", () => {
  it("does not send when customer emails are turned off in Email Settings", async () => {
    EmailConfig.findOne.mockReturnValue({
      lean: () => Promise.resolve({ enableCustomerEmails: false }),
    });

    await checkout.sendPaymentReceiptEmail({
      _id: "order1",
      email: "buyer@example.com",
      paidWith: "BankOfAmerica",
      line_items: [
        { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 649 } } } },
      ],
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("still sends when the config row does not exist yet", async () => {
    EmailConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await checkout.sendPaymentReceiptEmail({
      _id: "order1",
      email: "buyer@example.com",
      paidWith: "BankOfAmerica",
      line_items: [
        { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 649 } } } },
      ],
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("hasPendingCheckout — multi-tab duplicate-checkout guard", () => {
  it("returns true when a recent unpaid gateway order exists for the email", async () => {
    Order.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: "existing" }) });

    const result = await checkout.hasPendingCheckout("buyer@example.com");

    expect(result).toBe(true);
    const query = Order.findOne.mock.calls[0][0];
    expect(query.email).toBe("buyer@example.com");
    expect(query.paid).toBe(false);
    // Only one gateway remains, so this is a plain equality rather than a set.
    expect(query.paidWith).toBe("BankOfAmerica");
  });

  it("returns false when no pending order exists", async () => {
    Order.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await checkout.hasPendingCheckout("buyer@example.com");

    expect(result).toBe(false);
  });

  it("excludes confirmed declines so the customer can retry with another card", async () => {
    Order.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await checkout.hasPendingCheckout("buyer@example.com");

    const query = Order.findOne.mock.calls[0][0];
    expect(query.status).toEqual({ $ne: "payment failed" });
  });
});

describe("makeOrderObjAndTotal — server-side pricing (the core anti-tampering property)", () => {
  const dbProduct = {
    _id: "prod1",
    price: 999, // the real, database price
    productName: "iPhone 15",
    color: { name: "Black" },
    condition: "Mint",
    storage: "128GB",
    image: "/staticImages/iphone.png",
  };

  // The 8% the website has always shown as "Estimated tax" is now also charged,
  // so every total below is goods + tax + shipping. Tax is worked out from the
  // goods alone — shipping is never taxed — which is why this takes the goods
  // total rather than the order total.
  const taxOnGoods = (goodsTotal) => Math.round(goodsTotal * 0.08 * 100) / 100;

  it("computes the price from the database, ignoring anything price-like the client sent", async () => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = {
      body: {
        name: "Jane Doe",
        email: "jane@example.com",
        orders: ["prod1"],
        shipping: "standard",
        // A malicious/buggy client sending its own price — must be ignored.
        totalPrice: 1,
        price: 1,
      },
    };

    const { order, totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" });

    // 999 goods + 79.92 tax. The 999 comes from dbProduct.price, never from
    // the 1 the client asked to be charged, and the tax is worked out from
    // that same database price.
    expect(totalPrice).toBe(999 + taxOnGoods(999));
    expect(order.line_items[0].price_data.unit_amount).toBe(99900); // cents
    expect(order.paid).toBe(false);
    expect(order.status).toBe("pending_payment");
  });

  it("aggregates quantity when the same product id appears more than once in orders[]", async () => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = { body: { orders: ["prod1", "prod1", "prod1"], shipping: "standard" } };

    const { order, totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" });

    expect(order.line_items[0].quantity).toBe(3);
    // All three units are priced and taxed together: 2997 goods + 239.76 tax.
    expect(totalPrice).toBe(999 * 3 + taxOnGoods(999 * 3));
  });

  it.each([
    ["standard", 0],
    ["priority", 10.5],
    ["express", 25.0],
  ])("adds the correct shipping cost for '%s' shipping", async (shipping, expectedShippingCost) => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = { body: { orders: ["prod1"], shipping } };

    const { totalPrice } = await checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" });

    // Goods + tax + shipping. The tax is the same 79.92 in all three rows
    // because it is charged on the 999 of goods and never on the shipping —
    // only the shipping cost moves, so 1078.92, 1089.42 and 1103.92.
    expect(totalPrice).toBe(999 + taxOnGoods(999) + expectedShippingCost);
  });

  it("stamps the authenticated account onto the order", async () => {
    SingleVariation.find.mockResolvedValue([dbProduct]);
    const req = {
      body: { orders: ["prod1"], shipping: "standard", email: "typed@example.com" },
      user: { id: "user_abc", email: "account@example.com" },
    };

    const { order } = await checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" });

    // Ownership follows the session; the typed address stays the contact.
    expect(order.userId).toBe("user_abc");
    expect(order.email).toBe("typed@example.com");
  });

  it("refuses the checkout when a product id no longer exists", async () => {
    // The old guard tested `productsInfo` (always a truthy array) rather than
    // the item, so a missing product produced unit_amount: NaN and the order
    // total reached the bank as the string "NaN".
    SingleVariation.find.mockResolvedValue([]);
    const req = { body: { orders: ["prod1"], shipping: "standard" } };

    await expect(
      checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses the checkout when an item has sold out", async () => {
    SingleVariation.find.mockResolvedValue([{ ...dbProduct, outOfStock: true }]);
    const req = { body: { orders: ["prod1"], shipping: "standard" } };

    await expect(
      checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("gives every rejected item a message the checkout page can render", async () => {
    SingleVariation.find.mockResolvedValue([{ ...dbProduct, outOfStock: true }]);
    const req = { body: { orders: ["prod1"], shipping: "standard" } };

    const error = await checkout
      .makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" })
      .catch((e) => e);

    // extractApiError renders details as details.map(d => d.message) — an
    // entry without one shows the customer the word "undefined".
    expect(error.details).toHaveLength(1);
    expect(error.details[0].message).toContain("iPhone 15");
    expect(error.details.every((d) => typeof d.message === "string")).toBe(true);
  });

  it("does not let one sold-out item silently reduce the order", async () => {
    SingleVariation.find.mockResolvedValue([
      dbProduct,
      { ...dbProduct, _id: "prod2", productName: "iPhone 14", outOfStock: true },
    ]);
    const req = { body: { orders: ["prod1", "prod2"], shipping: "standard" } };

    // Partial fulfilment would charge for a cart the customer never agreed to.
    await expect(
      checkout.makeOrderObjAndTotal({ req, paidWith: "BankOfAmerica" })
    ).rejects.toMatchObject({ status: 409 });
  });
});
