// Keeping account numbers out of a phone shop's database.
//
// UpCell pays people for their old phones, which means somebody has to be
// told where to send the money. It does not follow that the number has to be
// stored, and it very much does not follow that it should end up in a free
// text box on a trade-in record.
//
// The failure this guards against is mundane and near-certain: a customer
// types their full account number into "anything else we should know", or a
// staff member pastes it into a note so they remember it. Nobody decided to
// store a bank account. It happened anyway, and now a phone shop's database
// is a payments database.

// Nine consecutive digits.
//
// A US account number is 8-12, a routing number is 9, and a card is 15-16. A
// phone number is 10 and an order reference can be long, so this will catch
// some things that are not bank details — which is the right way round. The
// cost of a false positive is somebody rewording a sentence; the cost of a
// miss is an account number sitting in a document nobody is protecting.
const LONG_DIGIT_RUN = /\d{9,}/;

// Spaces and dashes are how people actually write these, so they are removed
// before counting. "4417 2938 1102" is a card number whatever it looks like.
const stripSeparators = (value) => String(value ?? "").replace(/[\s-]/g, "");

/**
 * Whether this text looks like it has an account number in it.
 */
const looksLikeAccountNumber = (value) => LONG_DIGIT_RUN.test(stripSeparators(value));

/**
 * The message shown when it does.
 *
 * Says what to do instead, because a customer who is told "invalid" simply
 * types it again with a space in the middle.
 */
const ACCOUNT_NUMBER_MESSAGE =
  "Please don't put a full account or card number here — we don't store them. " +
  "The last four digits are enough.";

/**
 * Reduces a reference to what is safe to keep.
 *
 * Two shapes, because the payout methods have two. A Zelle handle is an email
 * or a phone number the customer already gave UpCell, so it is kept as it is.
 * An account number is reduced to its last four digits, which is what a bank
 * statement shows and what a customer would recognise.
 *
 * Applied on the way in rather than trusted from the client: masking done in
 * a browser is masking anybody can turn off.
 */
function maskReference(value, method) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  if (method === "ZELLE") {
    // Already something the customer published to UpCell. An email address or
    // a phone number, and shortening either would make it useless for
    // telling two of them apart.
    return raw.slice(0, 80);
  }

  const digits = stripSeparators(raw).replace(/\D/g, "");
  if (digits.length >= 4) return `•••• ${digits.slice(-4)}`;

  // A cheque payable to a name, or something else short. Kept as written,
  // capped, since there is nothing in it to mask.
  return raw.slice(0, 40);
}

module.exports = {
  LONG_DIGIT_RUN,
  ACCOUNT_NUMBER_MESSAGE,
  looksLikeAccountNumber,
  maskReference,
};
