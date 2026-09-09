// The promise: settled within two business days of inspection finishing.
//
// Two things make this worth its own file. Business days are not "hours times
// two" — an inspection finished on Friday afternoon is due Tuesday, and getting
// that wrong means either chasing staff over a weekend or quietly breaking a
// promise made to a customer. And the clock stops whenever UpCell is waiting on
// the customer rather than the other way round: a device sitting Activation
// Locked is not UpCell failing to act, and counting that time against the SLA
// makes the overdue queue meaningless.

const { CLOCK_PAUSED_STATUSES } = require("../constants/returnStatus");

const SETTLEMENT_BUSINESS_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

const isWeekend = (date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;

/**
 * Adds business days, skipping weekends.
 *
 * Deliberately does not know about public holidays. A hard-coded holiday list
 * is wrong the year after it is written, and being a day early on a handful of
 * dates is the harmless direction — it makes the queue nag slightly sooner, not
 * a promise slip.
 */
function addBusinessDays(from, days) {
  const result = new Date(from.getTime());
  let remaining = days;

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekend(result)) remaining -= 1;
  }

  return result;
}

/**
 * Starts the clock. Called when inspection completes, which is the moment
 * UpCell knows what it owes and the promise begins.
 */
function startClock(request, now = new Date()) {
  request.sla = {
    ...(request.sla || {}),
    clockStartedAt: now,
    clockPausedAt: undefined,
    dueAt: addBusinessDays(now, SETTLEMENT_BUSINESS_DAYS),
    breached: false,
  };

  return request.sla;
}

/**
 * Stops the clock while UpCell waits on the customer.
 *
 * Records when it paused rather than recomputing the deadline, so that
 * resuming can give back exactly the time that was lost. Pausing twice without
 * resuming keeps the first pause — otherwise a second call would silently
 * forgive the time between them.
 */
function pauseClock(request, now = new Date()) {
  if (!request.sla?.clockStartedAt) return request.sla;
  if (request.sla.clockPausedAt) return request.sla;

  request.sla.clockPausedAt = now;
  return request.sla;
}

/**
 * Restarts it, pushing the deadline out by however long the pause lasted.
 *
 * Extending the deadline rather than resetting it is the point: a return that
 * had four hours left when it paused has four hours left when it resumes, not
 * two fresh days. Resetting would let a request be parked and unparked to
 * escape the queue forever.
 */
function resumeClock(request, now = new Date()) {
  const pausedAt = request?.sla?.clockPausedAt;
  if (!pausedAt) return request?.sla;

  const pausedFor = now.getTime() - new Date(pausedAt).getTime();

  request.sla.dueAt = new Date(new Date(request.sla.dueAt).getTime() + pausedFor);
  request.sla.clockPausedAt = undefined;

  return request.sla;
}

/**
 * Keeps the clock in step with the status.
 *
 * Called on every transition so nothing has to remember to pause and resume by
 * hand — a rule applied in six controllers is a rule that is wrong in one of
 * them.
 */
function syncClockToStatus(request, status, now = new Date()) {
  if (CLOCK_PAUSED_STATUSES.includes(status)) return pauseClock(request, now);
  return resumeClock(request, now);
}

/** Past its deadline and not yet settled. */
function isOverdue(request, now = new Date()) {
  const dueAt = request?.sla?.dueAt;
  if (!dueAt) return false;
  if (["Refunded", "Closed", "Rejected", "ReturnShipped", "Cancelled", "Expired"].includes(request.status)) {
    return false;
  }
  // Paused means the ball is in the customer's court, so it is not late.
  if (request.sla.clockPausedAt) return false;

  return now.getTime() > new Date(dueAt).getTime();
}

/** Hours left, negative once it is late. Null when no clock is running. */
function hoursRemaining(request, now = new Date()) {
  const dueAt = request?.sla?.dueAt;
  if (!dueAt) return null;

  return Math.round((new Date(dueAt).getTime() - now.getTime()) / (60 * 60 * 1000));
}

module.exports = {
  addBusinessDays,
  startClock,
  pauseClock,
  resumeClock,
  syncClockToStatus,
  isOverdue,
  hoursRemaining,
  SETTLEMENT_BUSINESS_DAYS,
};
