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
// Alerts go to Google Chat and email. Mocked so the decision tests assert that
// staff were raised, without standing up a mail transport.
jest.mock("../src/services/alertService");

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
  Order.updateOne.mockResolvedValue({ modifiedCount: 1 });
  EmailConfig.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ enableCustomerEmails: true }) });

  // Stock succeeds unless a test says otherwise, so the tests about signed
  // fields and decisions are not also tests about inventory.
  const inventory = require("../src/services/inventory");
  inventory.reserveVariations.mockResolvedValue({ ok: true, unavailable: [] });
  inventory.releaseReservation.mockResolvedValue(0);
  inventory.soldAway.mockResolvedValue([]);
  inventory.markSold.mockResolvedValue(0);
  inventory.variationIdsFromOrder.mockReturnValue([]);

  const { sendOpsAlert } = require("../src/services/alertService");
  sendOpsAlert.mockResolvedValue({});
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
  const validCheckout = {
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
  };

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
        body: { ...validCheckout, ...overrides },
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

  // Settled in the portal, and stricter than the plan: Billing Information is
  // not merely Display on the hosted page, it is Disabled — the customer never
  // sees a billing field at all. That removes the retype risk entirely and
  // replaces it with a harder rule, printed on the portal tab itself: "You need
  // to POST fields required by your processor if you do not capture these via
  // Secure Acceptance." Nothing on the bank's page fills a gap any more.
  //
  // So this list has to stay in sync with the checkout form's own fields
  // (Frontend/src/pages/Checkout/Checkout.jsx) by hand: name, email, phone,
  // street, city, state, postal, country. There is no company or
  // address-line-2 field on either side, so none is expected here.
  it("sends every billing field the hosted page's Display setting needs", async () => {
    const fields = await prepare({});

    const billingFields = [
      "bill_to_forename",
      "bill_to_surname",
      "bill_to_email",
      "bill_to_phone",
      "bill_to_address_line1",
      "bill_to_address_city",
      "bill_to_address_state",
      "bill_to_address_postal_code",
      "bill_to_address_country",
    ];

    for (const name of billingFields) {
      expect(fields[name]).toBeTruthy();
      expect(fields.signed_field_names.split(",")).toContain(name);
    }
  });

  it("signs every field it posts, not just the billing ones", async () => {
    // The structural half of the same rule. A field posted outside the signed
    // set is one the bank will not treat as ours, and it would be an easy
    // thing to introduce by building the payload and the signature separately.
    const fields = await prepare({});

    const signed = new Set(fields.signed_field_names.split(","));
    const posted = Object.keys(fields).filter((name) => name !== "signature");

    for (const name of posted) {
      expect(signed.has(name)).toBe(true);
    }
  });

  it("refuses a checkout with no state rather than sending an empty one", async () => {
    // The schema leaves state optional for the admin Manual path. On this path
    // an empty bill_to_address_state passes the gateway's own field check and
    // then fails the issuer's address check — and this profile is set to
    // reverse the authorisation when AVS fails, so the sale is lost with
    // nothing on any form explaining why.
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };

    await boa.preparePayment(
      { user: { id: "user_abc" }, body: { ...validCheckout, state: undefined } },
      res,
      (e) => { throw e; }
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/state/i);
    // Nothing reserved, nothing written: a refused attempt must not leave an
    // order behind or a device held for a checkout that never happened.
    expect(Order.create).not.toHaveBeenCalled();
  });

  it.each(["FD", "ZZ", "New York"])(
    "refuses %s, which is not a state the issuer will recognise",
    async (state) => {
      const res = { statusCode: null, body: null };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => { res.body = payload; return res; };

      await boa.preparePayment(
        { user: { id: "user_abc" }, body: { ...validCheckout, state } },
        res,
        (e) => { throw e; }
      );

      expect(res.statusCode).toBe(400);
      expect(Order.create).not.toHaveBeenCalled();
    }
  );

  it("accepts a lower-case state, because the form does not force the shape", async () => {
    const fields = await prepare({ state: "ny" });

    expect(fields.bill_to_address_state).toBe("NY");
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
  // previousStatus is what the order held before this confirmation claimed it.
  // It matters for exactly one case: a review that comes back settled arrives
  // as a second message, and only that case can have lost its devices.
  const claimYields = (status, paid, previousStatus = "pending_payment") => {
    const order = {
      _id: ORDER_ID,
      email: "buyer@example.com",
      status: previousStatus,
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

  it("a review accepted after the device sold is flagged, not fulfilled", async () => {
    // The cost of never holding inventory for a human. Between REVIEW and
    // ACCEPT the twenty minutes ran out and somebody else bought the phone.
    // The money has moved and there is nothing to ship.
    const { sendOpsAlert } = require("../src/services/alertService");
    claimYields("Processing", true, "under_review");
    inventory.variationIdsFromOrder.mockReturnValue(["device-1"]);
    inventory.soldAway.mockResolvedValue(["device-1"]);

    const res = await post("ACCEPT");

    // Never sell it twice: the device belongs to whoever actually bought it.
    expect(inventory.markSold).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("oversell_collision");

    const [, update] = Order.updateOne.mock.calls[0];
    expect(update.$set.fulfilmentBlocked).toBe(true);
    expect(update.$set.fulfilmentBlockReason).toMatch(/reverse the authorisation/i);

    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "oversell_collision", urgent: true })
    );

    // The customer was charged. A silent charge is worse than a receipt
    // somebody has to follow up, so the receipt still goes.
    expect(mockSend).toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("only re-checks stock for an order that was actually under review", async () => {
    // An ordinary straight-through ACCEPT never lost its hold, so the extra
    // database round trip would be waste on every normal sale.
    claimYields("Processing", true, "pending_payment");
    inventory.variationIdsFromOrder.mockReturnValue(["device-1"]);

    await post("ACCEPT");

    expect(inventory.soldAway).not.toHaveBeenCalled();
    expect(inventory.markSold).toHaveBeenCalled();
  });

  it("treats a failed stock re-check as a collision rather than fulfilling blind", async () => {
    // Not knowing whether the device is still there is not the same as knowing
    // it is. Shipping on an unanswered question is how you sell it twice.
    claimYields("Processing", true, "under_review");
    inventory.variationIdsFromOrder.mockReturnValue(["device-1"]);
    inventory.soldAway.mockRejectedValue(new Error("mongo unreachable"));

    await post("ACCEPT");

    expect(inventory.markSold).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("oversell_collision");
  });

  it("REVIEW pays nothing and does NOT extend the stock hold", async () => {
    claimYields("under_review", false);

    const res = await post("REVIEW");

    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.status).toBe("under_review");
    expect(Order.findOneAndUpdate.mock.calls[0][1].$set.paid).toBe(false);

    // The decided rule: inventory is never held waiting for a human. The
    // ordinary twenty-minute hold runs out and the device returns to sale,
    // even though the bank has not finished deciding. Nothing here touches
    // the reservation in either direction — not extending it, and not
    // releasing it early either, because the customer may still be charged.
    expect(inventory.releaseReservation).not.toHaveBeenCalled();
    expect(inventory.markSold).not.toHaveBeenCalled();

    expect(eventTypes()).toContain("entered_review");
    expect(eventTypes()).not.toContain("marked_paid");
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("REVIEW raises an urgent alert, because the device is now racing a timer", async () => {
    const { sendOpsAlert } = require("../src/services/alertService");
    claimYields("under_review", false);

    await post("REVIEW");

    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    const alert = sendOpsAlert.mock.calls[0][0];
    expect(alert.urgent).toBe(true);
    expect(alert.kind).toBe("payment_review");
    // Throttling an alert about money would be the wrong economy: two reviews
    // inside fifteen minutes are two devices at risk, not one duplicate.
    expect(alert.lines.join(" ")).toContain(ORDER_ID);
  });

  it.each(["DECLINE", "ERROR", "CANCEL"])(
    "%s frees the devices, pays nothing and still answers 200",
    async (decision) => {
      claimYields("payment failed", false);

      const res = await post(decision);

      expect(Order.findOneAndUpdate.mock.calls[0][1].$set.status).toBe("payment failed");
      expect(inventory.releaseReservation).toHaveBeenCalledWith("checkout-uuid");
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

// The bank can and does deliver the same merchant POST more than once — a
// timeout on its side with no visibility into whether we actually received
// it is a normal reason to retry. The claim in merchantPost is meant to make
// a second delivery a no-op; the tests above only ever prove that by mocking
// what findOneAndUpdate returns. This one instead fakes Mongo's atomic-claim
// semantics against a single mutable order and calls merchantPost twice with
// the identical body, so it fails if that guarantee ever breaks for real.
describe("merchantPost — the same delivery arrives twice", () => {
  const inventory = require("../src/services/inventory");

  // Mirrors the real filter in bankOfAmerica.controller.js: claimable when
  // unclaimed, or still under review.
  const claim = (order, update) => {
    const claimable = !order.boaTransactionId || order.status === "under_review";
    if (!claimable) return null;
    Object.assign(order, update.$set);
    return { ...order };
  };

  it("pays, sells and emails once no matter how many times the same POST arrives", async () => {
    const order = {
      _id: ORDER_ID,
      email: "buyer@example.com",
      boaTransactionId: null,
      line_items: [
        { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 1109.5 } } } },
      ],
    };
    Order.findById.mockImplementation(async () => order);
    Order.findOneAndUpdate.mockImplementation(async (filter, update) => claim(order, update));

    const body = signedReply({ decision: "ACCEPT" });
    const first = makeRes();
    const second = makeRes();
    await boa.merchantPost({ body }, first, jest.fn());
    await flushMicrotasks();
    await boa.merchantPost({ body }, second, jest.fn());
    await flushMicrotasks();

    expect(first.sendStatus).toHaveBeenCalledWith(200);
    expect(second.sendStatus).toHaveBeenCalledWith(200);
    expect(order.paid).toBe(true);
    expect(inventory.markSold).toHaveBeenCalledTimes(1);
    // Two sends for one paid order — the customer receipt and the admin
    // notification — and the duplicate delivery must add neither.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(eventTypes()).toContain("duplicate_confirmation");
  });

  it("does not re-sell or re-email a device already marked sold by the first delivery", async () => {
    const order = {
      _id: ORDER_ID,
      email: "buyer@example.com",
      boaTransactionId: "7882749437566123004007",
      status: "Processing",
      paid: true,
      line_items: [
        { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 1109.5 } } } },
      ],
    };
    Order.findById.mockImplementation(async () => order);
    Order.findOneAndUpdate.mockImplementation(async (filter, update) => claim(order, update));

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "ACCEPT" }) }, res, jest.fn());
    await flushMicrotasks();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(inventory.markSold).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("duplicate_confirmation");
  });
});

// A review is deliberately re-claimable, because the bank sends a follow-up
// carrying the real decision once a person there has looked. That reopening is
// exactly what lets a *redelivered* REVIEW — the same message again, which the
// 63-second cold start on Render makes likely — run the review branch twice.
describe("merchantPost — a review message delivered twice", () => {
  const inventory = require("../src/services/inventory");

  const reviewedOrder = () => ({
    _id: ORDER_ID,
    email: "buyer@example.com",
    status: "under_review",
    boaTransactionId: "7882749437566123004007",
    line_items: [
      { quantity: 1, price_data: { product_data: { name: "iPhone", metadata: { totalPaid: 1109.5 } } } },
    ],
  });

  it("does not alert twice about a review that has not changed", async () => {
    const { sendOpsAlert } = require("../src/services/alertService");
    Order.findById.mockResolvedValue(reviewedOrder());

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "REVIEW" }) }, res, jest.fn());
    await flushMicrotasks();

    // An alert repeated for an unchanged situation is how a team learns to
    // ignore the alert that matters.
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(eventTypes()).toContain("duplicate_confirmation");
    expect(eventOfType("duplicate_confirmation").metadata.reason).toBe("review_redelivered");
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("still accepts the follow-up that settles the review, same transaction id and all", async () => {
    // The bank may reuse the transaction id when it settles. Refusing on the
    // id alone would drop the one message this reopening exists to accept —
    // the customer charged, the order left in review for ever.
    const order = reviewedOrder();
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({
      ...order,
      status: "Processing",
      paid: true,
      boaTransactionUuid: "checkout-uuid",
    });
    inventory.variationIdsFromOrder.mockReturnValue([]);

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "ACCEPT" }) }, res, jest.fn());
    await flushMicrotasks();

    expect(Order.findOneAndUpdate).toHaveBeenCalled();
    expect(eventTypes()).toContain("marked_paid");
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("treats a genuinely new review message as new, not as a redelivery", async () => {
    const { sendOpsAlert } = require("../src/services/alertService");
    const order = { ...reviewedOrder(), boaTransactionId: "an-earlier-transaction" };
    Order.findById.mockResolvedValue(order);
    Order.findOneAndUpdate.mockResolvedValue({
      ...order,
      status: "under_review",
      paid: false,
      boaTransactionUuid: "checkout-uuid",
    });

    const res = makeRes();
    await boa.merchantPost({ body: signedReply({ decision: "REVIEW" }) }, res, jest.fn());
    await flushMicrotasks();

    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(eventTypes()).toContain("entered_review");
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

  it("tells a declined customer their card was refused", async () => {
    const res = makeRes();
    await boa.paymentResponse({ body: signedReply({ decision: "DECLINE" }) }, res);

    expect(res.redirectedTo).toBe("https://shop.example.com/cart?payment=declined");
  });

  it.each(["ERROR", "SOMETHING_NEW"])(
    "does not tell a %s customer their card was declined",
    async (decision) => {
      // Their card was not refused. Sending them off to find another one is a
      // wasted trip, and it reads as though their bank turned them down when
      // it never saw the payment.
      const res = makeRes();
      await boa.paymentResponse({ body: signedReply({ decision }) }, res);

      expect(res.redirectedTo).toBe("https://shop.example.com/cart?payment=error");
    }
  );

  it("keeps reason codes and gateway messages out of the customer's URL", async () => {
    const res = makeRes();
    await boa.paymentResponse(
      {
        body: signedReply({
          decision: "DECLINE",
          reason_code: "102",
          message: "One or more fields contains invalid data",
          invalid_fields: "bill_to_surname",
        }),
      },
      res
    );

    expect(res.redirectedTo).not.toContain("102");
    expect(res.redirectedTo).not.toContain("invalid");
  });

  it("records what the customer was actually shown", async () => {
    // The merchant POST records what the bank decided. Nothing recorded what
    // the buyer saw, which is the first question asked when one writes in.
    const res = makeRes();
    await boa.paymentResponse(
      { body: signedReply({ decision: "ERROR", reason_code: "150" }) },
      res
    );

    const logged = PaymentEventLog.create.mock.calls
      .map((call) => call[0])
      .find((event) => event.metadata?.source === "customer_response" && event.metadata?.decision);

    expect(logged.metadata.shown_to_customer).toBe("error");
    expect(logged.metadata.reason_code).toBe("150");
  });

  it("never changes payment status on the browser route", async () => {
    // Anyone can request this URL. Only /boa/merchant-post may decide money.
    const res = makeRes();
    await boa.paymentResponse({ body: signedReply({ decision: "ACCEPT" }) }, res);

    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Order.updateOne).not.toHaveBeenCalled();
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

// A customer who clicks Cancel on the hosted page, often before entering a
// card at all, may never generate a merchant POST — there is no completed
// transaction for the bank to confirm server-to-server. Without this, the
// device stays held for the full twenty minutes for someone who already said
// they don't want it.
describe("paymentResponse — a customer who cancels frees the device immediately", () => {
  const inventory = require("../src/services/inventory");

  it("releases the hold for this checkout, not by guessing the order id", async () => {
    const res = makeRes();
    await boa.paymentResponse(
      { body: signedReply({ decision: "CANCEL", transaction_uuid: "checkout-uuid-9" }) },
      res
    );

    await flushMicrotasks();

    // Released by transaction_uuid — the checkout's own reservation key — not
    // by reference_number, which identifies the order, not the hold.
    expect(inventory.releaseReservation).toHaveBeenCalledWith("checkout-uuid-9");
    expect(res.redirectedTo).toBe("https://shop.example.com/cart?payment=cancelled");
  });

  it("only releases once the signature has verified — a forged cancel frees nothing", async () => {
    const res = makeRes();
    await boa.paymentResponse(
      { body: { ...signedReply({ decision: "CANCEL" }), signature: "not-real" } },
      res
    );

    await flushMicrotasks();

    expect(inventory.releaseReservation).not.toHaveBeenCalled();
  });

  it("still redirects to the cart even if the release itself fails", async () => {
    inventory.releaseReservation.mockRejectedValueOnce(new Error("db down"));

    const res = makeRes();
    await boa.paymentResponse({ body: signedReply({ decision: "CANCEL" }) }, res);

    expect(res.redirectedTo).toBe("https://shop.example.com/cart?payment=cancelled");
  });
});
