const crypto = require("crypto");

// The unguessable half of a link a customer can open without signing in.
//
// Two things need it: the one-click accept/decline on a revised offer, and the
// tracking page. Both arrive by email, and both have to work for someone
// reading on a phone who has not signed in for months — a login wall on
// "accept this offer" is how an offer times out and a device gets posted back.
//
// It is not a session. It grants exactly one return, it is checked against a
// single record, and it never confers admin. The plan is explicit that these
// pages must be reachable by token or by proven ownership and never by raw
// Mongo id — an id is sequential-ish, short, and appears in URLs people paste
// into support chats.
//
// 32 bytes, base64url: 256 bits of entropy, no padding, and safe in a URL
// without escaping.
const TOKEN_BYTES = 32;

const createAccessToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

// Compared in constant time. String equality on a secret leaks its prefix
// through timing — not a practical attack against 256 bits, but the correct
// habit costs one function call and the wrong habit gets copied.
function tokensMatch(candidate, stored) {
  if (!candidate || !stored) return false;

  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(stored));

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare lengths first and always run the comparison.
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

module.exports = { createAccessToken, tokensMatch, TOKEN_BYTES };
