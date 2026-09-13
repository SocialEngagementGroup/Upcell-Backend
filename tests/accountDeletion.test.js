process.env.CLERK_SECRET_KEY = "sk_test_fake";

const { anonymiseCustomer, pseudonymFor } = require("../src/services/accountDeletion");

const model = () => ({
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
  deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
});

const models = () => ({
  Order: model(),
  TradeInRequest: model(),
  RefundRequest: model(),
  ContactSubmission: model(),
  NewsletterSubscriber: model(),
});

// Two things pull against each other and both are real: a person can ask to be
// erased, and UpCell has to keep what was sold for tax, for a chargeback
// months later, and for a warranty claim on a device somebody still owns.
describe("erasing a customer without erasing the books", () => {
  it("anonymises the order rather than deleting it", async () => {
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "buyer@example.com" });

    const [, update] = m.Order.updateMany.mock.calls[0];
    expect(update.$set.name).toBe("Deleted account");
    expect(update.$set.phone).toBeUndefined();
    expect(update.$set.street).toBeUndefined();
    // Never a delete. The amounts, the dates and the devices survive.
    expect(m.Order.deleteMany).not.toHaveBeenCalled();
  });

  it("kills the guest link with the account", async () => {
    // Otherwise a link in an old receipt still opens an order belonging to
    // somebody who asked to be forgotten.
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "buyer@example.com" });

    const [, update] = m.Order.updateMany.mock.calls[0];
    expect(update.$unset).toHaveProperty("guestAccessToken");
    expect(update.$unset).toHaveProperty("guestTokenExpiresAt");
  });

  it("clears the chargeback evidence too", async () => {
    // A hashed IP and a user agent are still that person's, and once the
    // order cannot identify them there is nothing left to defend.
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "buyer@example.com" });

    const [, update] = m.Order.updateMany.mock.calls[0];
    expect(update.$unset).toHaveProperty("checkoutIpHash");
    expect(update.$unset).toHaveProperty("userAgent");
  });

  it("deletes what has no financial claim on it", async () => {
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "buyer@example.com" });

    expect(m.ContactSubmission.deleteMany).toHaveBeenCalled();
    expect(m.NewsletterSubscriber.deleteMany).toHaveBeenCalled();
    expect(m.ContactSubmission.updateMany).not.toHaveBeenCalled();
  });

  it("finds orders by the Clerk id and by the address", async () => {
    // Somebody who typed a different email at checkout still placed that
    // order, and it still has to be erased.
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "buyer@example.com" });

    const [filter] = m.Order.updateMany.mock.calls[0];
    expect(filter.$or).toEqual([{ userId: "user_1" }, { email: "buyer@example.com" }]);
  });

  it("matches the address case-insensitively, as a string", async () => {
    const m = models();
    await anonymiseCustomer({ models: m, userId: "user_1", email: "Buyer@Example.com" });

    const [filter, , options] = m.Order.updateMany.mock.calls[0];
    expect(options.collation).toEqual({ locale: "en", strength: 2 });
    expect(filter.$or[1].email instanceof RegExp).toBe(false);
  });

  it("reports what it actually did", async () => {
    // The audit row is written from this, so a vague answer would make the
    // record of an erasure useless.
    const summary = await anonymiseCustomer({
      models: models(), userId: "user_1", email: "buyer@example.com",
    });

    expect(summary).toMatchObject({ orders: 2, tradeIns: 2, returns: 2, contacts: 1, newsletter: 1 });
    expect(summary.pseudonym).toMatch(/^deleted-[0-9a-f]{12}$/);
  });
});

describe("the pseudonym", () => {
  it("is the same for the same person, so their orders still group", () => {
    expect(pseudonymFor("buyer@example.com")).toBe(pseudonymFor("buyer@example.com"));
  });

  it("ignores case, because an address is typed by a person", () => {
    expect(pseudonymFor("Buyer@Example.com")).toBe(pseudonymFor("buyer@example.com"));
  });

  it("differs between people", () => {
    expect(pseudonymFor("a@example.com")).not.toBe(pseudonymFor("b@example.com"));
  });

  it("does not contain the address it came from", () => {
    // The requirement is that rows can be grouped, not that the original can
    // be recovered. It cannot be.
    const pseudonym = pseudonymFor("buyer@example.com");

    expect(pseudonym).not.toContain("buyer");
    expect(pseudonym).not.toContain("example");
  });

  it("is salted, so the same address on another deployment differs", () => {
    const saved = process.env.CLERK_SECRET_KEY;
    const first = pseudonymFor("buyer@example.com");
    process.env.CLERK_SECRET_KEY = "sk_test_other";
    // Re-required because the salt is read at call time, not at import.
    const second = pseudonymFor("buyer@example.com");
    process.env.CLERK_SECRET_KEY = saved;

    expect(second).not.toBe(first);
  });
});
