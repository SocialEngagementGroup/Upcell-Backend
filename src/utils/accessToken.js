const crypto = require("crypto");

// The unguessable half of a link a customer can open without signing in.
//
// Three things need it: the one-click accept/decline on a revised offer, the
// page that shows what is being answered, and — from T22 — a guest's own
// order. All arrive by email, and all have to work for someone reading on a
// phone who has not signed in for months. A login wall on "accept this offer"
// is how an offer times out and a device gets posted back.
//
// It is not a session. It grants exactly one record, it is checked against
// that record, and it never confers admin. The plan is explicit that these
// pages must be reachable by token or by proven ownership and never by raw
// Mongo id — an id is sequential-ish, short, and appears in URLs people paste
// into support chats.
//
// 32 bytes, base64url: 256 bits of entropy, no padding, and safe in a URL
// without escaping.
const TOKEN_BYTES = 32;

const createAccessToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * What gets stored.
 *
 * The token used to be written onto the document as-is, hidden with
 * `select: false`. That hides a field from a query which does not ask for it;
 * it is not storage protection and was never meant to be. Anyone who could
 * read the database — a backup, an Atlas session, a leaked connection string —
 * could read a live token and answer a customer's refund offer as them.
 *
 * Hashed, the plaintext exists only inside the email that carries it. A stolen
 * database gives an attacker hashes, and a hash cannot be put in a URL.
 *
 * SHA-256 with no salt or stretching, deliberately. Those defend a low-entropy
 * secret against being guessed. This one is 256 random bits: there is no
 * dictionary to try, and a per-record salt would only stop an attacker
 * recognising that two records share a token — which cannot happen. What is
 * needed here is that the stored form is not usable as the sent form, and a
 * plain digest does that at a cost that suits a check on every page load.
 */
const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

/**
 * Whether this token from a URL matches the hash on the record.
 *
 * Named for what it compares. The old `tokensMatch(candidate, stored)` took
 * two plaintext tokens, and a name that did not say which side was hashed is
 * how a call site ends up comparing a token against a hash and silently
 * refusing every real customer — or worse, comparing plaintext to plaintext
 * because that is what the field happened to hold.
 *
 * Constant time. String equality on a secret leaks its prefix through timing —
 * not a practical attack against 256 bits, but the correct habit costs one
 * function call and the wrong habit gets copied.
 */
function tokenMatchesHash(candidate, storedHash) {
  if (!candidate || !storedHash) return false;

  const a = Buffer.from(hashToken(candidate));
  const b = Buffer.from(String(storedHash));

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Both sides are a 64-character digest when the stored value is one,
  // so a mismatch here means the record holds something that is not a hash.
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

module.exports = { createAccessToken, hashToken, tokenMatchesHash, TOKEN_BYTES };
