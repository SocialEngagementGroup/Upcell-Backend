// Deleting a customer's account without deleting UpCell's books.
//
// These pull in opposite directions and both are real. A person can ask for
// their data to be erased. UpCell has to keep a record of what was sold, for
// what, to whom, and when — for tax, for a chargeback months later, and for a
// warranty claim on a device somebody still owns.
//
// The resolution is anonymisation rather than deletion for anything financial.
// The order survives with its amounts, its dates and its devices intact; the
// person is removed from it. What is left cannot identify anybody and still
// answers every question an accountant or a card scheme would ask.
//
// What is genuinely deleted is what has no such claim on it: a newsletter
// subscription, a contact form message.

const crypto = require("crypto");

// A stable stand-in, so two orders from the same deleted person still group
// together in a report without naming them.
//
// Salted with a server secret and truncated: the point is that rows can be
// grouped, not that the original can be recovered. It cannot be, and that is
// the requirement rather than a limitation.
const pseudonymFor = (email) => {
  const salt = process.env.CLERK_SECRET_KEY || "upcell";
  const digest = crypto.createHash("sha256").update(salt + String(email).toLowerCase()).digest("hex");
  return `deleted-${digest.slice(0, 12)}`;
};

const ANONYMISED = (pseudonym) => ({
  name: "Deleted account",
  email: `${pseudonym}@deleted.invalid`,
  phone: undefined,
  street: undefined,
  city: undefined,
  postal: undefined,
});

/**
 * Erases a customer, keeping the financial record.
 *
 * Deliberately not a transaction. Mongo would support one, but the steps are
 * independent and a partial run is recoverable by running it again — whereas
 * a transaction that fails halfway on a free-tier replica set leaves the
 * caller with an error and no idea how far it got. Each step reports its own
 * count so the audit row says what actually happened.
 *
 * @returns {Promise<{pseudonym: string, orders: number, tradeIns: number,
 *   returns: number, contacts: number, newsletter: number}>}
 */
async function anonymiseCustomer({ models, userId, email }) {
  const { Order, TradeInRequest, RefundRequest, ContactSubmission, NewsletterSubscriber } = models;

  const pseudonym = pseudonymFor(email);
  const replacement = ANONYMISED(pseudonym);
  const insensitive = { locale: "en", strength: 2 };

  // Matched on the Clerk id first and the address second, because a customer
  // who typed a different email at checkout still placed that order.
  const mine = { $or: [{ userId }, { email }] };

  const [orders, tradeIns, returns] = await Promise.all([
    Order.updateMany(mine, {
      $set: { ...replacement, userId: undefined },
      // The guest link has to die with the account, or a link in an old
      // receipt still opens an order the person asked to be forgotten.
      $unset: { guestAccessToken: "", guestTokenExpiresAt: "", checkoutIpHash: "", userAgent: "" },
    }, { collation: insensitive }),

    TradeInRequest.updateMany(mine, { $set: replacement }, { collation: insensitive }),

    // A return carries the inspection and the money, so it is anonymised like
    // an order rather than deleted.
    RefundRequest.updateMany(mine, {
      $set: { email: replacement.email, userId: undefined },
      $unset: { accessToken: "" },
    }, { collation: insensitive }),
  ]);

  // These two have no financial claim on them at all, so they go.
  const [contacts, newsletter] = await Promise.all([
    ContactSubmission.deleteMany({ email }, { collation: insensitive }),
    NewsletterSubscriber.deleteMany({ email }, { collation: insensitive }),
  ]);

  return {
    pseudonym,
    orders: orders.modifiedCount || 0,
    tradeIns: tradeIns.modifiedCount || 0,
    returns: returns.modifiedCount || 0,
    contacts: contacts.deletedCount || 0,
    newsletter: newsletter.deletedCount || 0,
  };
}

module.exports = { anonymiseCustomer, pseudonymFor };
