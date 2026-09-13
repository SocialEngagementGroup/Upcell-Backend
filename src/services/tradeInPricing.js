// What UpCell will pay for a device somebody is trading in.
//
// This used to run in the browser. The page worked out a number, posted it,
// and the server stored whatever arrived — so opening dev tools and posting
// `estimate: 9999` produced an email to staff offering nine thousand dollars
// for a phone. The number a customer sees still comes from here; the
// difference is that it is computed on the server both times, so the quote and
// the stored figure cannot disagree.
//
// Pure and deterministic: same inputs, same answer, no database and no clock.
// That is what lets the parity test below prove the migration changed nobody's
// quote, and what makes a disputed number reproducible months later from the
// breakdown alone.

const { round2 } = require("../utils/money");

// Everything below works in cents, but a quote is a whole-dollar figure and
// rounds to one — the same way the browser did, and the way a trade-in offer
// is actually made. Nobody is offered $165.50 for a phone.
//
// It matters more than it looks. Rounding to the cent and letting the page
// round again to the dollar rounds twice, and at an exact half-cent the two
// disagree: 590 x 0.85 x 0.55 x 0.75 x 0.80 is 165.495, which the browser
// quoted as $165, and which rounds to 16550 cents and then back up to $166.
// A quote that moved by a dollar on the day this shipped is indistinguishable
// from a quote that was always wrong.
const toWholeDollarCents = (cents) => Math.round(cents / 100) * 100;

/**
 * A quote, and the arithmetic that produced it.
 *
 * @param {object} args
 * @param {object} args.priceBook  the model's row: basePriceCents, multipliers
 * @param {object[]} args.questions the question set for its device type
 * @param {string} args.storage
 * @param {string} args.carrier
 * @param {object} args.answers    { [questionId]: optionId | boolean }
 *
 * @returns {{ok: true, estimateCents, breakdown, priceBookVersion}
 *          |{ok: false, error}}
 */
function quote({ priceBook, questions = [], storage, carrier, answers = {} } = {}) {
  if (!priceBook || !priceBook.active) {
    return { ok: false, error: "We are not quoting for that model at the moment." };
  }

  const base = Number(priceBook.basePriceCents);
  if (!Number.isFinite(base) || base <= 0) {
    return { ok: false, error: "We are not quoting for that model at the moment." };
  }

  const breakdown = [{ step: "base", multiplier: 1, resultCents: base }];
  let cents = base;

  const apply = (step, multiplier) => {
    cents = cents * multiplier;
    breakdown.push({ step, multiplier, resultCents: Math.round(cents) });
  };

  // Storage. An unknown size is 1.0 rather than an error: the catalogue gains
  // sizes faster than this table does, and refusing to quote for a 2TB Mac is
  // worse than quoting the base price for one.
  if (storage) {
    apply(`storage:${storage}`, Number(priceBook.storageMultipliers?.[storage]) || 1);
  }

  // Carrier. Every adjustment is 1.0 today — the browser never used carrier in
  // its arithmetic, and this migration must not change anybody's number. The
  // field exists so a locked handset can be worth less later without a code
  // change.
  if (carrier) {
    apply(`carrier:${carrier}`, Number(priceBook.carrierAdjustments?.[carrier]) || 1);
  }

  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined || answer === null) continue;

    if (question.type === "boolean") {
      // Only "no" moves the price. A yes is the assumption the base price was
      // set against.
      if (answer === false || answer === "no") {
        const multiplier = Number(question.noMultiplier);
        if (!Number.isFinite(multiplier)) continue;

        apply(`${question.id}:no`, multiplier);

        // A device that will not switch on cannot be graded any further —
        // every question after this one is asking about something nobody can
        // check. The browser stopped here too.
        if (question.terminal) {
          return {
            ok: true,
            estimateCents: toWholeDollarCents(cents),
            breakdown,
            terminatedAt: question.id,
            priceBookVersion: priceBook.priceBookVersion || 1,
          };
        }
      }
      continue;
    }

    // A choice. An answer nobody offered is ignored rather than trusted: the
    // options are the server's list, and an id that is not on it is either a
    // stale page or somebody typing into the request.
    const option = (question.options || []).find((entry) => entry.id === answer);
    if (!option) continue;

    const multiplier = Number(option.multiplier);
    if (!Number.isFinite(multiplier) || multiplier === 1) continue;

    apply(`${question.id}:${option.id}`, multiplier);
  }

  return {
    ok: true,
    estimateCents: toWholeDollarCents(cents),
    breakdown,
    priceBookVersion: priceBook.priceBookVersion || 1,
  };
}

/**
 * The most a device of this model could be worth.
 *
 * The "up to $X" on the model list, before anybody has answered anything. It
 * is the best storage and the best answer to every question — which is what
 * "up to" has to mean, or the page is quoting a number no real device reaches.
 */
function teaser({ priceBook, questions = [] } = {}) {
  if (!priceBook?.active) return 0;

  const storages = Object.entries(priceBook.storageMultipliers || {});
  const bestStorage = storages.length
    ? storages.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
    : undefined;

  // Best answers only: every boolean yes, and the highest-multiplier choice.
  const answers = {};
  for (const question of questions) {
    if (question.type === "boolean") {
      answers[question.id] = true;
      continue;
    }
    const best = (question.options || [])
      .reduce((top, option) => ((Number(option.multiplier) || 0) > (Number(top?.multiplier) || 0) ? option : top), null);
    if (best) answers[question.id] = best.id;
  }

  const result = quote({ priceBook, questions, storage: bestStorage, answers });
  return result.ok ? result.estimateCents : 0;
}

/** Cents to the dollars the page and the email show. */
const toDollars = (cents) => round2(Number(cents || 0) / 100);

module.exports = { quote, teaser, toDollars };
