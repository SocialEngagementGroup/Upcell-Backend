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
