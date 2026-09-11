// The append-only record of everything that happened to a return — or to a
// trade-in, which is the same journey run backwards and keeps the same log.
//
// This is the dispute record. "The customer says they posted it, we say it
// never arrived" is only answerable from a log nobody can edit — and with two
// or three staff all able to approve, attribution is the only control there is.
//
// Entries are only ever pushed. Nothing in this file updates or removes one,
// and nothing else should either: a timeline that can be corrected after the
// fact is worth nothing in an argument.
const returnStatus = require("../constants/returnStatus");

// Which set of rules to check a move against. Returns by default, so every
// existing caller reads the same as it always did and a trade-in has to ask
// for its own map explicitly — a missed argument fails loudly on the first
// illegal transition rather than quietly allowing one.
const RETURNS = returnStatus;

/**
 * Adds an entry. Does not save — the caller saves once, after making all its
 * changes, so a request and its timeline can never be written apart.
 *
 * @param {object} request  the ReturnRequest document
 * @param {object} entry
 * @param {string} entry.event      what happened, e.g. "status_changed"
 * @param {string} [entry.actor]    Clerk id or email; "system" for a job
 * @param {string} [entry.actorType] staff | customer | system
 * @param {string} [entry.from]     previous status, for a transition
 * @param {string} [entry.to]       new status
 * @param {object} [entry.meta]     anything else worth keeping
 */
function recordEvent(request, { event, actor = "system", actorType = "system", from, to, meta } = {}) {
  if (!request) return null;
  if (!Array.isArray(request.timeline)) request.timeline = [];

  const entry = {
    at: new Date(),
    actor: actor || "system",
    actorType,
    event,
    from,
    to,
    meta,
  };

  request.timeline.push(entry);
  return entry;
}

/**
 * Moves a request to a new status, or explains why it cannot.
 *
 * This is the only way a status should change. A controller reaching for
 * findByIdAndUpdate on `status` skips the transition map, and an illegal state
 * reached once stays reached — there is nothing later that puts it back.
 *
 * Does not save, for the same reason recordEvent does not.
 *
 * @param {object} [options.machine]  the status module to check against.
 *        Defaults to returns; pass constants/tradeInStatus for a trade-in.
 *
 * @returns {{ok: true, from, to} | {ok: false, error: string, allowed: string[]}}
 */
function applyTransition(request, to, { actor = "system", actorType = "system", event = "status_changed", meta, machine = RETURNS } = {}) {
  const from = request?.status;

  if (!machine.canTransition(from, to)) {
    return {
      ok: false,
      error: machine.transitionError(from, to),
      allowed: machine.ALLOWED_TRANSITIONS[from] || [],
    };
  }

  request.status = to;
  recordEvent(request, { event, actor, actorType, from, to, meta });

  return { ok: true, from, to };
}

module.exports = { recordEvent, applyTransition };
