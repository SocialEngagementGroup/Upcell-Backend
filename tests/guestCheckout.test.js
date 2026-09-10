process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";
process.env.CLERK_SECRET_KEY = "sk_test_fake";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));
jest.mock("../src/models/order.model");
jest.mock("../src/models/auditLog.model");
jest.mock("../src/models/notification.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/emailConfig.model");
// order.controller destructures makeOrderObjAndTotal at import time, so a spy
// set later never reaches the reference it captured.
jest.mock("../src/controllers/checkout.controller", () => ({
  makeOrderObjAndTotal: jest.fn(),
  sendPaymentReceiptEmail: jest.fn(),
  sendAdminNewOrderEmail: jest.fn(),
  orderLineItemsForReceipt: jest.fn(() => []),
  orderTotal: jest.fn(() => 0),
}));

const Order = require("../src/models/order.model");
const AuditLog = require("../src/models/auditLog.model");
const orderController = require("../src/controllers/order.controller");
const {
  guestFieldsFor,
  issueGuestToken,
  guestTokenOpens,
  checkoutEvidence,
} = require("../src/services/guestOrder");
const { ownsOrder } = require("../src/utils/orderView");
const { hashToken } = require("../src/utils/accessToken");

const makeReqRes = (body = {}, { params = {}, query = {}, user, headers = {} } = {}) => {
  const req = { body, params, query, user, headers, ip: "203.0.113.7" };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
    send: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
});

// Checkout was behind a sign-in wall. For a used-device shop that is the
// biggest thing between a visitor and a sale, and the account it forced them
// to make unlocked nothing but the order they were already placing.
describe("marking an order a guest order", () => {
  it("flags an anonymous buyer's order", () => {
    expect(guestFieldsFor({ user: undefined }).fields.guest).toBe(true);
  });

  it("does not flag a signed-in buyer's", () => {
    // Their Clerk id is the ownership proof. A token would be a second key
    // that has to be tracked and can be forwarded.
    expect(guestFieldsFor({ user: { id: "user_1" } }).fields.guest).toBe(false);
  });

  it("mints no token at checkout", () => {
    // The plaintext cannot survive the trip to the bank and back — checkout
    // hands the customer off, and the receipt is sent from a different
    // request that has only read the order back from the database.
    expect(guestFieldsFor({}).fields.guestAccessToken).toBeUndefined();
    expect(guestFieldsFor({}).token).toBeNull();
  });
});

describe("issuing the token when the first email goes out", () => {
  const guestOrder = () => ({ guest: true, save: jest.fn().mockResolvedValue(true) });

  it("mints one and stores only its hash", () => {
    const order = guestOrder();

    return issueGuestToken(order).then((token) => {
      expect(token).toEqual(expect.any(String));
      expect(token.length).toBeGreaterThan(40);
      expect(order.guestAccessToken).toMatch(/^[0-9a-f]{64}$/);
      expect(order.guestAccessToken).not.toBe(token);
      expect(order.save).toHaveBeenCalled();
    });
  });

  it("expires it in ninety days", async () => {
    const now = new Date("2026-09-11T00:00:00Z");
    const order = guestOrder();

    await issueGuestToken(order, { now });

    const days = (order.guestTokenExpiresAt - now) / (24 * 60 * 60 * 1000);
    expect(days).toBe(90);
  });

  it("mints nothing for a signed-in customer's order", async () => {
    const order = { guest: false, save: jest.fn() };

    expect(await issueGuestToken(order)).toBeNull();
    expect(order.save).not.toHaveBeenCalled();
  });

  it("never rotates one that already exists", async () => {
    // The receipt email is the durable record. A customer who kept it must
    // still be able to open their order six weeks later, and a later email
    // that quietly invalidated that link would break the one they are most
    // likely to still have.
    const order = { guest: true, guestAccessToken: "a".repeat(64), save: jest.fn() };

    expect(await issueGuestToken(order)).toBeNull();
    expect(order.guestAccessToken).toBe("a".repeat(64));
    expect(order.save).not.toHaveBeenCalled();
  });
});

describe("the guest link", () => {
  const orderWith = (token, expiresAt) => ({
    guestAccessToken: hashToken(token),
    guestTokenExpiresAt: expiresAt,
  });

  const ahead = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const behind = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it("opens the order it was minted for", () => {
    expect(guestTokenOpens(orderWith("abc", ahead), "abc")).toBe(true);
  });

  it("does not open a different order", () => {
    // The failure that matters most: one guest reading another's order.
    expect(guestTokenOpens(orderWith("abc", ahead), "xyz")).toBe(false);
  });

  it("stops working once it has expired", () => {
    expect(guestTokenOpens(orderWith("abc", behind), "abc")).toBe(false);
  });

  it("refuses an order that has no token at all", () => {
    // A signed-in customer's order must not be openable by passing anything.
    expect(guestTokenOpens({ guestAccessToken: undefined }, "abc")).toBe(false);
    expect(guestTokenOpens({}, "")).toBe(false);
  });

  it("cannot be answered with the stored hash", () => {
    const order = orderWith("abc", ahead);

    expect(guestTokenOpens(order, order.guestAccessToken)).toBe(false);
  });
});

describe("who a guest order answers to", () => {
  const guestOrder = {
    _id: "order1",
    guest: true,
    guestAccessToken: hashToken("good-token"),
    guestTokenExpiresAt: new Date(Date.now() + 86400000),
  };

  it("answers the holder of its own token", () => {
    expect(ownsOrder(undefined, guestOrder, "good-token")).toBe(true);
  });

  it("answers nobody else, signed in or not", () => {
    expect(ownsOrder(undefined, guestOrder, "wrong-token")).toBe(false);
    expect(ownsOrder(undefined, guestOrder, undefined)).toBe(false);
    expect(ownsOrder({ id: "user_x", emailVerified: true }, guestOrder, undefined)).toBe(false);
  });

  it("still answers an admin", () => {
    expect(ownsOrder({ id: "a", role: "admin" }, guestOrder)).toBe(true);
  });

  it("does not let a guest token open a signed-in customer's order", () => {
    // The token arm must not become a skeleton key. An order belonging to an
    // account has no guest hash, so there is nothing for a token to match.
    const owned = { _id: "order2", userId: "user_owner" };

    expect(ownsOrder(undefined, owned, "good-token")).toBe(false);
  });
});

describe("GET /order/:id with a guest token", () => {
  const order = {
    _id: "order1",
    guest: true,
    email: "buyer@example.com",
    items: [],
    totalCents: 107892,
    guestAccessToken: hashToken("good-token"),
    guestTokenExpiresAt: new Date(Date.now() + 86400000),
  };

  const ask = async (token, user) => {
    Order.findById.mockReturnValue({
      select: () => Promise.resolve({ ...order, toObject: () => order }),
    });

    const { req, res } = makeReqRes({}, {
      params: { id: "6a79f7298341f33d9a65b0b7" },
      query: token ? { t: token } : {},
      user,
    });
    await orderController.getOrder(req, res, jest.fn());
    return res;
  };

  it("shows the order to the link's holder", async () => {
    const res = await ask("good-token");

    expect(res.statusCode).toBe(200);
    expect(sent(res).totalCents).toBe(107892);
  });

  it("404s a wrong token, exactly as it 404s no token", async () => {
    const wrong = await ask("wrong-token");
    const none = await ask(undefined);

    expect(wrong.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(sent(wrong)).toEqual(sent(none));
  });

  it("never sends the guest hash back in the response", async () => {
    // Otherwise reading the order once hands over the key to it forever.
    const res = await ask("good-token");

    expect(JSON.stringify(sent(res))).not.toContain(order.guestAccessToken);
  });
});

describe("claiming guest orders after signing up", () => {
  const claim = async (user, found = [{ _id: "order1" }, { _id: "order2" }]) => {
    Order.find.mockReturnValue({
      collation: () => ({ select: () => ({ lean: async () => found }) }),
    });
    Order.updateMany.mockResolvedValue({ modifiedCount: found.length });
    AuditLog.create.mockResolvedValue({});

    const { req, res, next } = makeReqRes({}, { user });
    await orderController.claimGuestOrders(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return res;
  };

  const verified = { id: "user_1", email: "buyer@example.com", emailVerified: true };

  it("attaches orders placed with the same verified address", async () => {
    const res = await claim(verified);

    expect(res.statusCode).toBe(200);
    expect(sent(res).claimed).toBe(2);
  });

  it("refuses an unverified email", async () => {
    // The whole security of this. Clerk lets anyone sign up claiming any
    // address; without verification, taking over a stranger's orders needs
    // their email address and no access to it.
    const res = await claim({ ...verified, emailVerified: false });

    expect(res.statusCode).toBe(403);
    expect(Order.updateMany).not.toHaveBeenCalled();
  });

  it("clears the token on the orders it moves", async () => {
    // They have an owner now. A live link that still opens an order belonging
    // to an account is a second key nobody is tracking.
    await claim(verified);

    const [, update] = Order.updateMany.mock.calls[0];
    expect(update.$set).toMatchObject({ userId: "user_1", guest: false });
    expect(update.$unset).toHaveProperty("guestAccessToken");
    expect(update.$unset).toHaveProperty("guestTokenExpiresAt");
  });

  it("only takes orders that are guest and unowned", async () => {
    await claim(verified);

    const [filter] = Order.updateMany.mock.calls[0];
    expect(filter.guest).toBe(true);
    expect(filter.userId).toEqual({ $in: [null, undefined, ""] });
  });

  it("matches the address whatever case it was typed in", async () => {
    // Buyer@Example.com at checkout and buyer@example.com at sign-up is the
    // same person. Done with a collation rather than a regex, so there is no
    // user input being compiled into a pattern.
    await claim({ ...verified, email: "Buyer@Example.com" });

    const [filter, , options] = Order.updateMany.mock.calls[0];
    expect(filter.email).toBe("buyer@example.com");
    expect(options.collation).toEqual({ locale: "en", strength: 2 });
  });

  it("compares the address as a plain string, never as a pattern", async () => {
    // An unescaped "." in a regex matches any character, so a.b@x.com would
    // also have claimed aXb@x.com. A string equality cannot do that.
    await claim({ ...verified, email: "a.b@example.com" });

    const [filter] = Order.updateMany.mock.calls[0];
    expect(filter.email).toBe("a.b@example.com");
    expect(filter.email instanceof RegExp).toBe(false);
  });

  it("reads with the same collation it writes with", async () => {
    // Two different rules would claim a set of orders and then update a
    // different one.
    await claim(verified);

    expect(Order.find).toHaveBeenCalledWith(
      expect.objectContaining({ email: "buyer@example.com" })
    );
  });
});

describe("chargeback evidence", () => {
  it("hashes the IP rather than storing it", () => {
    // The question a chargeback asks is "did these two orders come from the
    // same place", which a digest answers. The raw value would only add the
    // ability to tell where the customer lives.
    const evidence = checkoutEvidence({ headers: {}, ip: "203.0.113.7" });

    expect(evidence.checkoutIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("203.0.113.7");
  });

  it("gives the same hash for the same address", () => {
    const a = checkoutEvidence({ headers: {}, ip: "203.0.113.7" });
    const b = checkoutEvidence({ headers: {}, ip: "203.0.113.7" });

    expect(a.checkoutIpHash).toBe(b.checkoutIpHash);
  });

  it("reads the forwarded address first, since Render sits behind a proxy", () => {
    const direct = checkoutEvidence({ headers: {}, ip: "10.0.0.1" });
    const forwarded = checkoutEvidence({
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      ip: "10.0.0.1",
    });

    expect(forwarded.checkoutIpHash).not.toBe(direct.checkoutIpHash);
  });

  it("truncates a user agent rather than storing an essay", () => {
    const evidence = checkoutEvidence({ headers: { "user-agent": "x".repeat(5000) }, ip: "1.2.3.4" });

    expect(evidence.userAgent).toHaveLength(300);
  });

  it("records nothing rather than empty strings when there is nothing to record", () => {
    const evidence = checkoutEvidence({ headers: {} });

    expect(evidence.checkoutIpHash).toBeUndefined();
    expect(evidence.userAgent).toBeUndefined();
  });
});

// The plan warned about this and it was real: AuditLog.targetId is a required
// ObjectId, so a row logged for "several orders at once" fails validation
// inside a swallowed catch and the claim goes unrecorded.
describe("the claim leaves a trail", () => {
  it("writes one audit row per order, each naming a real order id", async () => {
    Order.find.mockReturnValue({
      collation: () => ({ select: () => ({ lean: async () => [{ _id: "order1" }, { _id: "order2" }] }) }),
    });
    Order.updateMany.mockResolvedValue({ modifiedCount: 2 });
    AuditLog.create.mockResolvedValue({});

    const { req, res, next } = makeReqRes({}, {
      user: { id: "user_1", email: "buyer@example.com", emailVerified: true },
    });
    await orderController.claimGuestOrders(req, res, next);

    expect(AuditLog.create).toHaveBeenCalledTimes(2);
    for (const [row] of AuditLog.create.mock.calls) {
      expect(row.targetType).toBe("Order");
      expect(row.targetId).toBeDefined();
      expect(row.action).toBe("order.guest_order_claimed");
    }
  });

  it("writes nothing and updates nothing when there is nothing to claim", async () => {
    Order.find.mockReturnValue({ collation: () => ({ select: () => ({ lean: async () => [] }) }) });

    const { req, res, next } = makeReqRes({}, {
      user: { id: "user_1", email: "buyer@example.com", emailVerified: true },
    });
    await orderController.claimGuestOrders(req, res, next);

    expect(sent(res).claimed).toBe(0);
    expect(Order.updateMany).not.toHaveBeenCalled();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });
});

// Order.create returns everything it was handed, select:false or not. An
// endpoint that answers with that document undoes the lockdown on the endpoint
// beside it.
describe("POST /orders does not hand back what GET /order/:id withholds", () => {
  it("answers with the customer view, not the document", async () => {
    const created = {
      _id: "order1",
      email: "buyer@example.com",
      guest: true,
      guestAccessToken: hashToken("secret"),
      checkoutIpHash: "abc123",
      userAgent: "Mozilla/5.0",
      avsResult: "Y",
      boaTransactionId: "7284419920176543904007",
      items: [],
      totalCents: 107892,
      toObject() { return this; },
    };

    Order.create.mockResolvedValue(created);
    require("../src/controllers/checkout.controller")
      .makeOrderObjAndTotal.mockResolvedValue({ order: {}, totalPrice: 1078.92 });

    const { req, res, next } = makeReqRes({ paidWith: "Manual" }, { user: undefined });
    await orderController.createOrder(req, res, next);

    const body = sent(res);
    for (const leaked of ["guestAccessToken", "checkoutIpHash", "userAgent", "avsResult", "boaTransactionId"]) {
      expect(body[leaked]).toBeUndefined();
    }
    expect(body.totalCents).toBe(107892);
  });
});
