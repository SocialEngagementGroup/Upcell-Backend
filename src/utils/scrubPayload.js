// Strips card data out of a gateway payload before it is written to the
// database.
//
// The bank's reply is the only independent evidence of what happened in a
// transaction, so it is worth keeping for a dispute. But storing it verbatim
// would mean this server holds card data, and the whole reason for using the
// bank's hosted page is that it never does — that is what keeps us on the
// easiest PCI tier (SAQ A). One careless save undoes that.
//
// Deny-by-pattern, not an allow-list of known fields: the gateway can add a
// field at any time, and a new field must fail closed rather than be stored
// because nobody updated a list.

// Anything whose name mentions a security code. These must never be stored,
// not even masked — PCI forbids retaining them after authorisation at all.
const FORBIDDEN_KEY = /(cvn|cvv|cvc|security[_-]?code|card[_-]?verification)/i;

// Card-number-ish fields. Kept, but reduced to the last four digits.
const CARD_NUMBER_KEY = /(card[_-]?number|account[_-]?number|pan)\b/i;

// A bare run of 12-19 digits anywhere in a value. Catches an unmasked number
// arriving in a field we did not anticipate.
const BARE_PAN = /\b\d{12,19}\b/g;

const lastFour = (value) => {
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 4 ? `xxxx${digits.slice(-4)}` : "xxxx";
};

/**
 * @param {object} payload  raw form body from the gateway
 * @returns {object} a copy safe to persist
 */
function scrubPayload(payload) {
  if (!payload || typeof payload !== "object") return {};

  const safe = {};

  for (const [key, rawValue] of Object.entries(payload)) {
    if (FORBIDDEN_KEY.test(key)) {
      safe[key] = "[removed]";
      continue;
    }

    // Nested objects are not expected from a urlencoded form body, but a
    // future JSON callback would arrive that way and must not slip through.
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      safe[key] = scrubPayload(rawValue);
      continue;
    }

    const value = String(rawValue ?? "");

    if (CARD_NUMBER_KEY.test(key)) {
      safe[key] = lastFour(value);
      continue;
    }

    // The gateway already masks req_card_number as xxxxxxxxxxxx1111, so this
    // normally changes nothing. It exists for the case where it doesn't.
    safe[key] = value.replace(BARE_PAN, (match) => lastFour(match));
  }

  return safe;
}

module.exports = { scrubPayload };
