// Env must be set before the controller is required — accessKey, secretKey,
// profileId, endpoint and frontendUrl are all read at module load.
process.env.BOA_ACCESS_KEY = "test-access-key";
process.env.BOA_SECRET_KEY = "test-secret-key";
process.env.BOA_PROFILE_ID = "test-profile-id";
process.env.BOA_ENDPOINT = "https://testsecureacceptance.example.com/pay";
process.env.FRONTEND_URL = "https://shop.example.com";
process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";

const mockSend = jest.fn().mockResolvedValue({});
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

jest.mock("../src/models/order.model");
jest.mock("../src/models/paymentEventLog.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/emailConfig.model");
// The controller destructures these at require time, so the module has to be
// mocked rather than spied on — a spy installed later would not replace the
// reference the controller already captured. What the real ones do to stock is
// covered in inventory.test.js; here we only care that the right one is called.
jest.mock("../src/services/inventory");

const Order = require("../src/models/order.model");
const PaymentEventLog = require("../src/models/paymentEventLog.model");
const { EmailConfig } = require("../src/models/emailConfig.model");
const boa = require("../src/controllers/bankOfAmerica.controller");

const ORDER_ID = "6a79f7298341f33d9a65b0b7";
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const makeRes = () => {
  const res = { statusCode: 200, redirectedTo: null, body: null };
  res.sendStatus = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.redirect = jest.fn((url) => {
    res.redirectedTo = url;
    return res;
  });
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
};

// Build a payload the way the gateway does: request fields echoed back with a
// req_ prefix, gateway-generated fields unprefixed, then signed.
const signedReply = (overrides = {}) =>
  boa.buildSignedFields({
    decision: "ACCEPT",
    transaction_id: "7882749437566123004007",
    auth_amount: "1109.50",
    req_reference_number: ORDER_ID,
    req_amount: "1109.50",
    req_currency: "usd",
    req_card_type: "001",
    req_card_number: "xxxxxxxxxxxx1111",
    ...overrides,
  });

const eventTypes = () =>
  PaymentEventLog.create.mock.calls.map((call) => call[0].eventType);

const eventOfType = (type) =>
  PaymentEventLog.create.mock.calls.map((c) => c[0]).find((e) => e.eventType === type);

beforeEach(() => {
  jest.clearAllMocks();
  PaymentEventLog.create.mockResolvedValue({});
  EmailConfig.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ enableCustomerEmails: true }) });

  // Stock succeeds unless a test says otherwise, so the tests about signed
  // fields and decisions are not also tests about inventory.
  const inventory = require("../src/services/inventory");
  inventory.reserveVariations.mockResolvedValue({ ok: true, unavailable: [] });
  inventory.releaseReservation.mockResolvedValue(0);
  inventory.holdForReview.mockResolvedValue(0);
  inventory.markSold.mockResolvedValue(0);
  inventory.variationIdsFromOrder.mockReturnValue([]);
});

describe("signature round trip", () => {
  it("verifies a payload it signed itself", () => {
    expect(boa.verifySignature(signedReply())).toBe(true);
  });

  it("rejects a payload whose amount was altered after signing", () => {
    const tampered = { ...signedReply(), auth_amount: "1.00" };
    expect(boa.verifySignature(tampered)).toBe(false);
  });

  it("rejects a payload with no signature at all", () => {
    expect(boa.verifySignature({ decision: "ACCEPT" })).toBe(false);
  });
});

describe("fields sent to the gateway — reason code 102 causes", () => {
  const prepare = async (overrides) => {
    Order.create.mockImplementation(async (doc) => ({
      _id: ORDER_ID,
      toString: () => ORDER_ID,
      ...doc,
      _idString: ORDER_ID,
    }));
    Order.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    let captured = null;
    const res = {
      json: (payload) => { captured = payload.fields; return res; },
      status() { return this; },
    };
    await boa.preparePayment(
      {
        user: { id: "user_abc" },
        body: {
          name: "Communications",
          email: "communications@socialengagementgroup.com",
          phone: "(313) 288-8312",
          city: "Astoria",
          state: "NY",
          postal: "11105",
          street: "20-25 Shore Blvd apt 16a",
          country: "United States",
          orders: ["68b59c07d4a1e2b8c3f10a51"],
          shipping: "standard",
          ...overrides,
        },
      },
      res,
      (e) => { throw e; }
    );
    return captured;
  };

  beforeEach(() => {
    const SingleVariation = require("../src/models/singleVariation.model");
    const device = {
      _id: "68b59c07d4a1e2b8c3f10a51", price: 100, productName: "iPhone",
      color: { name: "Black" }, condition: "Good", storage: "128GB", image: "/x.png",
    };
    // A mongoose query is both awaitable and chainable. Building the order
    // awaits find() directly; holding the device narrows it with
    // .select().lean() first, to skip accessories.
    SingleVariation.find.mockImplementation(() => ({
      select: () => ({ lean: async () => [device] }),
      lean: async () => [device],
      then: (resolve, reject) => Promise.resolve([device]).then(resolve, reject),
    }));
    // preparePayment now holds each device before handing the customer over,
    // so the claim has to succeed for these field-formatting tests to reach
    // the point where the signed fields are built.
    SingleVariation.findOneAndUpdate.mockImplementation((filter) => ({
      lean: async () => ({ _id: filter._id }),
    }));
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  it("never sends a bare hyphen as the surname for a one-word name", async () => {
    // surname "-" is invalid field data to Secure Acceptance and declines the
    // whole transaction with reason code 102. Five real attempts hit this.
    const fields = await prepare({ name: "Communications" });

    expect(fields.bill_to_surname).not.toBe("-");
    expect(fields.bill_to_forename).toBe("Communications");
    expect(fields.bill_to_surname).toBe("Communications");
  });

  it("strips punctuation a customer naturally types into a phone number", async () => {
    const fields = await prepare({ phone: "(313) 288-8312" });

    expect(fields.bill_to_phone).toBe("3132888312");
    expect(fields.bill_to_phone).toMatch(/^\d*$/);
  });

  it("keeps a normal two-part name intact", async () => {
    const fields = await prepare({ name: "Ashraf Uddin" });

    expect(fields.bill_to_forename).toBe("Ashraf");
    expect(fields.bill_to_surname).toBe("Uddin");
  });

  it("caps the phone at the gateway's 15-character limit", async () => {
    const fields = await prepare({ phone: "+1 (313) 288-8312 ext 99999999" });

    expect(fields.bill_to_phone.length).toBeLessThanOrEqual(15);
  });
});

describe("merchantPost — reading the echoed reference number", () => {
  // The regression this suite exists for. Secure Acceptance returns the
  // reference as req_reference_number; the controller read reference_number,
  // got undefined, and answered 200 without recording anything. Two ACCEPTed
  // payments on 2026-09-01 were verified, logged, and silently dropped.
  it("matches the order from req_reference_number", async () => {
    const order = { _id: ORDER_ID, line_items: [], email: "buyer@example.com" };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({ ...order, paid: true, status: "Processing" });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ auth_amount: "0.00", req_amount: "0.00" }) }, res, jest.fn());

    expect(Order.findById).toHaveBeenCalledWith(ORDER_ID);
    expect(Order.findOneAndUpdate).toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("flags a confirmation whose reference is missing instead of dropping it", async () => {
    const body = boa.buildSignedFields({
      decision: "ACCEPT",
      transaction_id: "7882749437566123004007",
      auth_amount: "10.00",
    });

    const res = makeRes();
    await boa.merchantPost({ body }, res, jest.fn());

    expect(Order.findById).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("unmatched_confirmation");
    expect(eventOfType("unmatched_confirmation").metadata.reason).toBe(
      "missing_or_malformed_reference"
    );
    // Still 200 — a 4xx would make the bank retry a payload we cannot use.
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("records which fields the gateway rejected", async () => {
    const order = { _id: ORDER_ID, email: "buyer@example.com", line_items: [] };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({ ...order, paid: false });

    // A reason-102 rejection names the offending fields. Discarding them is
    // what forced the cause to be reconstructed from the database by hand.
    const body = signedReply({
      decision: "REJECT",
      reason_code: "102",
      invalidField_0: "bill_to_surname",
      invalidField_1: "bill_to_phone",
    });

    await boa.merchantPost({ body }, makeRes(), jest.fn());

    const received = eventOfType("webhook_received");
    expect(received.metadata.reason_code).toBe("102");
    expect(received.metadata.invalid_fields).toEqual(["bill_to_surname", "bill_to_phone"]);
  });

  it("omits the invalid-fields key entirely on a clean confirmation", async () => {
    const order = { _id: ORDER_ID, email: "buyer@example.com", line_items: [] };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({ ...order, paid: true });

    await boa.merchantPost({ body: signedReply({ auth_amount: "0.00" }) }, makeRes(), jest.fn());

    expect(eventOfType("webhook_received").metadata).not.toHaveProperty("invalid_fields");
  });

  it("flags a confirmation for an order that does not exist", async () => {
    Order.findById.mockResolvedValue(null);

    const res = makeRes();
    await boa.merchantPost({ body: signedReply() }, res, jest.fn());

    expect(eventOfType("unmatched_confirmation").metadata.reason).toBe("no_such_order");
  });
});

describe("merchantPost — amount verification", () => {
  const orderWorth = (total) => ({
    _id: ORDER_ID,
    email: "buyer@example.com",
    line_items: [
      { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: total } } } },
    ],
  });

  it("marks the order paid when the authorised amount matches", async () => {
    Order.findById.mockResolvedValue(orderWorth(1109.5));
    Order.findOneAndUpdate.mockResolvedValue({ ...orderWorth(1109.5), paid: true });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply() }, res, jest.fn());

    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ORDER_ID }),
      expect.objectContaining({ $set: expect.objectContaining({ paid: true, status: "Processing" }) }),
      expect.anything()
    );
    await flushMicrotasks();
    expect(eventTypes()).toContain("marked_paid");
  });

  it("refuses to mark paid when the bank authorised a different amount", async () => {
    Order.findById.mockResolvedValue(orderWorth(1109.5));
    Order.findOneAndUpdate.mockResolvedValue({ ...orderWorth(1109.5), paid: false });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ auth_amount: "10.00" }) }, res, jest.fn());

    expect(eventTypes()).toContain("amount_mismatch");
    expect(Order.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ paid: false }) }),
      expect.anything()
    );
    // The transaction id is still recorded — losing it would leave a real
    // charge with no way to find it in the Business Center.
    const update = Order.findOneAndUpdate.mock.calls[0][1].$set;
    expect(update.boaTransactionId).toBe("7882749437566123004007");
  });
});

describe("merchantPost — declines and retries", () => {
  it("marks a declined order as payment failed and sends no receipt", async () => {
    const order = { _id: ORDER_ID, email: "buyer@example.com", line_items: [] };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({ ...order, paid: false, status: "payment failed" });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "DECLINE" }) }, res, jest.fn());

    await flushMicrotasks();
    expect(eventTypes()).not.toContain("marked_paid");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not send a second receipt when a retried confirmation loses the race", async () => {
    Order.findById.mockResolvedValue({ _id: ORDER_ID, email: "buyer@example.com", line_items: [] });
    // The atomic claim matched nothing: another worker already settled it.
    Order.findOneAndUpdate.mockResolvedValue(null);

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ auth_amount: "0.00" }) }, res, jest.fn());

    await flushMicrotasks();
    expect(eventTypes()).toContain("duplicate_confirmation");
    expect(eventTypes()).not.toContain("marked_paid");
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("rejects a forged confirmation without touching the order", async () => {
    const res = makeRes();
    await boa.merchantPost(
      { body: { ...signedReply(), signature: "notarealsignature" } },
      res,
      jest.fn()
    );

    expect(Order.findById).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("signature_rejected");
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});

// The gateway can answer with any of five words, and each one has to be a
// deliberate decision here. REVIEW used to be absent: it fell through to
// pending_payment, which released the device back on sale and was then swept
// away as an abandoned cart twelve hours later, while the customer could still
// be charged.
describe("merchantPost — every decision the gateway can send", () => {
  const inventory = require("../src/services/inventory");

  // What the atomic claim would produce for a given decision, so the branch
  // after it is exercised with the status it will really see. The order is
  // worth exactly what signedReply authorises, or the amount check would refuse
  // to mark it paid and every decision would look the same.
  const claimYields = (status, paid) => {
    const order = {
      _id: ORDER_ID,
      email: "buyer@example.com",
      line_items: [
        { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 1109.5 } } } },
      ],
    };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({
      ...order,
      status,
      paid,
      boaTransactionUuid: "checkout-uuid",
    });
  };

  const post = async (decision) => {
    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision }) }, res, jest.fn());
    await flushMicrotasks();
    return res;
  };

  it("ACCEPT marks the order paid, sells the devices and sends one receipt", async () => {
    claimYields("Processing", true);

    const res = await post("ACCEPT");

    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.status).toBe("Processing");
    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.paid).toBe(true);
    expect(eventTypes()).toContain("marked_paid");
    expect(inventory.markSold).toHaveBeenCalled();
    expect(inventory.releaseReservation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("REVIEW holds the devices instead of releasing them, and pays nothing", async () => {
    claimYields("under_review", false);

    const res = await post("REVIEW");

    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.status).toBe("under_review");
    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.paid).toBe(false);

    // The whole point: the device stays off sale while a person at the bank
    // decides. Releasing it here is what allowed the same phone to be sold
    // twice, and the 20-minute hold expiring is why merely not releasing is
    // not enough.
    expect(inventory.holdForReview).toHaveBeenCalledWith("checkout-uuid");
    expect(inventory.releaseReservation).not.toHaveBeenCalled();
    expect(inventory.markSold).not.toHaveBeenCalled();

    expect(eventTypes()).toContain("held_for_review");
    expect(eventTypes()).not.toContain("marked_paid");
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it.each(["DECLINE", "ERROR", "CANCEL"])(
    "%s frees the devices, pays nothing and still answers 200",
    async (decision) => {
      claimYields("payment failed", false);

      const res = await post(decision);

      expect(Order.findOneAndUpdate.mock.calls[0][1].$set.status).toBe("payment failed");
      expect(inventory.releaseReservation).toHaveBeenCalledWith("checkout-uuid");
      expect(inventory.holdForReview).not.toHaveBeenCalled();
      expect(inventory.markSold).not.toHaveBeenCalled();
      expect(eventTypes()).not.toContain("marked_paid");
      expect(mockSend).not.toHaveBeenCalled();
      expect(res.sendStatus).toHaveBeenCalledWith(200);
    }
  );

  it("a decision we have never seen is reported, not quietly filed as failed", async () => {
    claimYields("pending_payment", false);

    const res = await post("SOMETHING_NEW");

    // Guessing "failed" would free a device for a payment that may have gone
    // through; guessing "paid" is worse. Leave it unsettled and say so.
    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.paid).toBe(false);
    expect(eventTypes()).toContain("unknown_decision");
    expect(eventOfType("unknown_decision").metadata.decision).toBe("SOMETHING_NEW");
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});

describe("merchantPost — a review that finishes", () => {
  it("lets the bank's second message settle an order already under review", async () => {
    // A review ends with a second confirmation carrying the real decision. The
    // first one already filled in boaTransactionId, so on an unclaimed-only
    // filter this follow-up looked like a duplicate and was dropped: the
    // customer was charged and the order sat in review for ever.
    Order.findById.mockResolvedValue({ _id: ORDER_ID, email: "buyer@example.com", line_items: [] });
    Order.findOneAndUpdate.mockResolvedValue({
      _id: ORDER_ID,
      email: "buyer@example.com",
      line_items: [],
      status: "Processing",
      paid: true,
    });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "ACCEPT" }) }, res, jest.fn());
    await flushMicrotasks();

    const [filter] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toContainEqual({ status: "under_review" });
    expect(eventTypes()).toContain("marked_paid");
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("still refuses a second message for an order that is already settled", async () => {
    Order.findById.mockResolvedValue({ _id: ORDER_ID, email: "buyer@example.com", line_items: [] });
    // Neither branch of the claim matches: not unclaimed, not under review.
    Order.findOneAndUpdate.mockResolvedValue(null);

    const res = makeRes();
    await boa.merchantPost({ body: signedReply() }, res, jest.fn());
    await flushMicrotasks();

    expect(eventTypes()).toContain("duplicate_confirmation");
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});

describe("paymentResponse — a reviewed customer is not told they are done", () => {
  it("keeps a review off the order-confirmed page", async () => {
    const res = makeRes();
    await boa.paymentResponse({ body: signedReply({ decision: "REVIEW" }) }, res);

    // "Order confirmed" is a promise the shop cannot take back if the bank
    // later refuses the payment.
    expect(res.redirectedTo).not.toContain("/succeed");
    expect(res.redirectedTo).toContain("payment=review");
  });
});

describe("paymentResponse — where the customer lands", () => {
  it("sends the customer to the thank-you page using the echoed reference", async () => {
    const res = makeRes();
    await boa.paymentResponse({ body: signedReply() }, res);

    expect(res.redirectedTo).toBe(`https://shop.example.com/succeed?order_id=${ORDER_ID}`);
  });

  it("sends a declined customer back to the cart", async () => {
    const res = makeRes();
    await boa.paymentResponse({ body: signedReply({ decision: "DECLINE" }) }, res);

    expect(res.redirectedTo).toBe("https://shop.example.com/cart?payment=failed");
  });

  it("distinguishes a forged response from one it cannot read", async () => {
    const forged = makeRes();
    await boa.paymentResponse({ body: { ...signedReply(), signature: "bad" } }, forged);
    expect(eventTypes()).toContain("signature_rejected");

    jest.clearAllMocks();
    PaymentEventLog.create.mockResolvedValue({});

    const unreadable = makeRes();
    await boa.paymentResponse(
      { body: boa.buildSignedFields({ decision: "ACCEPT", transaction_id: "abc" }) },
      unreadable
    );
    // Signature was valid; only the reference was unusable. Logging this as
    // signature_rejected is what disguised the req_ prefix bug as an attack.
    expect(eventTypes()).toContain("unmatched_confirmation");
    expect(eventTypes()).not.toContain("signature_rejected");
  });
});
