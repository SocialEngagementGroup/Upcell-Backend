// Letting somebody buy a phone without making an account first.
//
// Checkout was behind a sign-in wall. For a used-device shop that is the
// biggest thing standing between a visitor and a sale — and the account it
// forced them to make was worth nothing to them, because the only thing it
// unlocked was the order they were already placing.
//
// A guest order is identified by an unguessable token in a link, the same way
// a return offer is. The token is 256 random bits, only its hash is stored,
// and it grants exactly one order and never anything else.

const crypto = require("crypto");
const { createAccessToken, hashToken, tokenMatchesHash } = require("../utils/accessToken");

// Ninety days. Long enough to cover a delivery, a return window and an
// argument about either; short enough that a link forwarded once and forgotten
// does not stay live for years in somebody's inbox.
const GUEST_TOKEN_DAYS = 90;

/**
 * The fields a guest order carries that a signed-in one does not.
 */
function guestFieldsFor({ user } = {}) {
  // Only the flag. The token is minted when the first email goes out, not
  // here — see issueGuestToken below for why.
  return { fields: { guest: !user?.id }, token: null };
}

/**
 * Mints the token for a guest order and stores its hash. Saves the order.
 *
 * Minted at the moment an email needs it rather than at checkout, because the
 * plaintext cannot survive the gap. Checkout hands the customer to the bank
 * and the receipt is sent later, from the bank's callback, in a different
 * request — by then the order has been read back from the database and holds
 * only a hash. A token minted at checkout would be unrecoverable exactly when
 * it is first needed.
 *
 * Minted once. A second call returns null rather than rotating, because the
 * receipt email is the durable record: a customer who kept it must still be
 * able to open their order six weeks later, and a later email that quietly
 * invalidated that link would break the one they are most likely to have.
 *
 * @returns {Promise<string|null>} the plaintext, or null if there is nothing
 *   to mint — a signed-in customer, or a guest who already has one.
 */
async function issueGuestToken(order, { now = new Date() } = {}) {
  if (!order?.guest) return null;
  if (order.guestAccessToken) return null;

  const token = createAccessToken();

  order.guestAccessToken = hashToken(token);
  order.guestTokenExpiresAt = new Date(now.getTime() + GUEST_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await order.save();

  return token;
}

/**
 * Whether this token opens this order.
 *
 * Expiry is checked before the hash, but both must pass and neither says which
 * failed — an expired-token message would confirm the order exists.
 */
function guestTokenOpens(order, token, now = new Date()) {
  if (!order?.guestAccessToken || !token) return false;

  const expiresAt = order.guestTokenExpiresAt;
  if (expiresAt && new Date(expiresAt).getTime() < now.getTime()) return false;

  return tokenMatchesHash(token, order.guestAccessToken);
}

/**
 * What a chargeback argument needs, and nothing more.
 *
 * The IP is hashed. Unhashed it is personal data UpCell has no use for: the
 * question a chargeback asks is "did these two orders come from the same
 * place", and a digest answers that. What it cannot do is tell anyone where
 * the customer lives, which is the only thing keeping the raw value would add.
 *
 * Salted with a server secret so the hash cannot be reversed by trying all
 * four billion IPv4 addresses — which, unlike a 256-bit token, is a dictionary
 * small enough to exhaust in minutes.
 */
function checkoutEvidence(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "";
  const salt = process.env.CLERK_SECRET_KEY || "upcell";

  return {
    checkoutIpHash: ip ? crypto.createHash("sha256").update(salt + ip).digest("hex") : undefined,
    // Truncated: a user agent is long, occasionally enormous, and only the
    // front of it identifies the browser.
    userAgent: String(req.headers?.["user-agent"] || "").slice(0, 300) || undefined,
  };
}

module.exports = {
  guestFieldsFor,
  issueGuestToken,
  guestTokenOpens,
  checkoutEvidence,
  GUEST_TOKEN_DAYS,
};
