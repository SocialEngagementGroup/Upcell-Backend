// Recording that the customer has actually been paid.
//
// Settlement is not automated and is not pretending to be. UpCell refunds by
// bank transfer or by handing over cash, matching how the order was paid, and
// both of those happen outside this system — a person moves the money and then
// records that they did. What this enforces is that the record is good enough
// to answer "who was paid, how much, by whom, and what is the proof".
//
// The alternative is what already exists on orders: a status that says Refunded
// with nothing behind it, which is indistinguishable from a mistake.

const SETTLEMENT_METHODS = ["CASH", "BANK_TRANSFER", "ORIGINAL_PAYMENT"];

// A cash handover has no bank record behind it. The signed receipt is the only
// evidence that a specific person received a specific amount, and with two or
// three staff able to settle, it is also the only thing tying it to whoever
// handed it over.
const REQUIRES_RECEIPT = ["CASH"];

// A transfer has a reference from the bank. Without it there is nothing to
// match against a statement when the customer says it never arrived.
const REQUIRES_REFERENCE = ["BANK_TRANSFER", "ORIGINAL_PAYMENT"];

/**
 * The method that should be offered, from how the order was paid.
 *
 * Refunding by a different route from the payment is how money goes missing and
 * how a refund becomes untraceable. This is a default rather than a rule: a
 * customer whose card has since been cancelled has to be paid some other way,
 * and staff can choose one.
 */
function defaultMethodFor(order) {
  const paidWith = String(order?.paidWith || "").toLowerCase();

  if (paidWith === "manual") return "CASH";
  // Card and BankOfAmerica both settle back to the original payment once
  // CyberSource refunds are live; until then staff will pick BANK_TRANSFER.
  if (paidWith.includes("card") || paidWith.includes("bank")) return "ORIGINAL_PAYMENT";

  return "BANK_TRANSFER";
}

/**
 * Whether this settlement can be recorded.
 *
 * @returns {{ok: true, settlement} | {ok: false, error: string}}
 */
function validateSettlement({ method, amount, reference, receiptUrl, expectedAmount }) {
  if (!SETTLEMENT_METHODS.includes(method)) {
    return { ok: false, error: `Settlement method must be one of: ${SETTLEMENT_METHODS.join(", ")}.` };
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Enter the amount that was actually paid." };
  }

  // Paying more than was agreed is a mistake worth catching before it leaves,
  // not after. Paying less is allowed: a partial handover happens, and the
  // shortfall is visible against the agreed figure.
  if (expectedAmount != null && value > Number(expectedAmount) + 0.005) {
    return {
      ok: false,
      error: `That is more than the $${Number(expectedAmount).toFixed(2)} agreed for this return.`,
    };
  }

  if (REQUIRES_RECEIPT.includes(method) && !String(receiptUrl || "").trim()) {
    return {
      ok: false,
      error: "A cash refund needs a photo of the signed receipt — without it there is no record of who was paid.",
    };
  }

  if (REQUIRES_REFERENCE.includes(method) && !String(reference || "").trim()) {
    return {
      ok: false,
      error: "Enter the bank reference, so this can be matched against a statement later.",
    };
  }

  return {
    ok: true,
    settlement: {
      settlementMethod: method,
      settlementAmount: Math.round(value * 100) / 100,
      settlementRef: reference ? String(reference).trim() : undefined,
      receiptUrl: receiptUrl ? String(receiptUrl).trim() : undefined,
    },
  };
}

/**
 * What the return ended as, for reporting.
 *
 * Derived from how it got here rather than asked for separately: a settled
 * return that went through a revised offer is a partial acceptance whether or
 * not anyone remembered to say so.
 */
function outcomeFor(request) {
  if (request?.resolution?.outcome) return request.resolution.outcome;

  const wentThroughOffer = (request?.timeline || []).some(
    (entry) => entry.event === "revised_offer_accepted"
  );

  return wentThroughOffer ? "PARTIAL_ACCEPTED" : "FULL_REFUND";
}

module.exports = {
  SETTLEMENT_METHODS,
  REQUIRES_RECEIPT,
  REQUIRES_REFERENCE,
  defaultMethodFor,
  validateSettlement,
  outcomeFor,
};
