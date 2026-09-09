// Offering a customer less than the full refund, and being able to say why.
//
// A revised offer is the middle option between paying in full and sending the
// device back. Without it, a phone that arrives in worse condition than
// described has only two endings: UpCell absorbs the difference, or the
// customer gets nothing and an argument. Most of those cases should settle.
//
// The rule that makes it defensible is that every deduction points at a finding
// from the inspection. A customer asking "why is this less" gets a list — this
// check failed, this photo shows it, this much came off — rather than a smaller
// number and a shrug. A deduction with nothing behind it is refused here, not
// argued about later.

const DEDUCTION_TYPES = ["DAMAGE", "MISSING_ITEMS", "RESTOCKING_FEE", "INBOUND_POSTAGE"];

// Deductions a staff member proposes have to name the check that justifies
// them. These two are the exception: they come from policy rather than from
// anything found on the bench.
const POLICY_DEDUCTIONS = ["RESTOCKING_FEE", "INBOUND_POSTAGE"];

const round2 = (value) => Math.round(value * 100) / 100;

const failedKeys = (checklist = []) =>
  checklist.filter((entry) => entry?.result === "fail").map((entry) => entry.key);

/**
 * Checks a proposed set of deductions and works out what is left.
 *
 * The offered amount is computed here and never accepted from the caller — the
 * same rule the refund total follows. A posted amount is a posted price.
 *
 * @param {object} params
 * @param {number} params.itemsTotal   what the customer paid for what is coming back
 * @param {object[]} params.deductions [{ type, amount, reason, findingKey }]
 * @param {object[]} params.checklist  the completed inspection checklist
 * @returns {{ok: true, deductions, totalDeducted, offeredAmount}
 *          | {ok: false, errors: string[]}}
 */
function buildRevisedOffer({ itemsTotal, deductions = [], checklist = [] }) {
  const errors = [];
  const failed = new Set(failedKeys(checklist));

  if (!deductions.length) {
    errors.push("A revised offer needs at least one deduction — otherwise it is a full refund.");
  }

  const clean = [];

  for (const deduction of deductions) {
    const { type, amount, reason, findingKey } = deduction || {};

    if (!DEDUCTION_TYPES.includes(type)) {
      errors.push(`"${type}" is not a kind of deduction.`);
      continue;
    }

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${type} needs an amount greater than zero.`);
      continue;
    }

    // The whole point. A number with no explanation is what a customer disputes
    // and what UpCell then cannot defend.
    if (!String(reason || "").trim()) {
      errors.push(`${type} needs a reason the customer can read.`);
      continue;
    }

    if (!POLICY_DEDUCTIONS.includes(type)) {
      if (!findingKey) {
        errors.push(`${type} has to name the check that justifies it.`);
        continue;
      }
      // Naming a check that passed is worse than naming none: it looks
      // evidenced when it is not.
      if (!failed.has(findingKey)) {
        errors.push(
          `${type} points at "${findingKey}", but that check did not fail during inspection.`
        );
        continue;
      }
    }

    clean.push({ type, amount: round2(value), reason: String(reason).trim(), findingKey });
  }

  const totalDeducted = round2(clean.reduce((sum, entry) => sum + entry.amount, 0));

  // Taking off more than the customer paid turns a refund into a bill. If the
  // device is worth that little, the answer is rejection, not a negative offer.
  if (totalDeducted > itemsTotal) {
    errors.push(
      `The deductions come to $${totalDeducted.toFixed(2)}, more than the $${Number(itemsTotal).toFixed(2)} paid. Reject the return instead.`
    );
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    deductions: clean,
    totalDeducted,
    offeredAmount: round2(itemsTotal - totalDeducted),
  };
}

// How long a customer has to answer. Silence is a decline: a device cannot sit
// on a shelf indefinitely waiting for someone who has stopped reading their
// email, and declining sends it back rather than keeping it.
const OFFER_RESPONSE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const offerExpiryFrom = (now = new Date()) => new Date(now.getTime() + OFFER_RESPONSE_DAYS * DAY_MS);

const offerHasExpired = (request, now = new Date()) => {
  const expiresAt = request?.refundBreakdown?.offerExpiresAt;
  if (!expiresAt) return false;
  return now.getTime() > new Date(expiresAt).getTime();
};

module.exports = {
  buildRevisedOffer,
  offerExpiryFrom,
  offerHasExpired,
  OFFER_RESPONSE_DAYS,
  DEDUCTION_TYPES,
};
