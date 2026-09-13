// Issuing and expiring a return authorisation.
//
// An RMA is a promise with a deadline: UpCell agrees to take the device back,
// and the customer has 14 days to actually post it. Without the deadline a
// queue fills with returns that were approved months ago and will never arrive,
// and nobody can tell those apart from the ones still on their way.

const RMA_EXPIRY_DAYS = 14;

// When the customer is nudged. Day 7 is halfway, day 12 is two days before it
// lapses — late enough to be urgent, early enough to still act on.
const REMINDER_DAYS = [7, 12];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Gives a request its RMA number and its clock.
 *
 * The number is issued against the collection rather than computed from a
 * counter, so two approvals in the same instant cannot both take it — see
 * utils/rma.js. Does not save; the caller saves once with everything else.
 *
 * @param {object} request        the ReturnRequest document
 * @param {object} deps
 * @param {object} deps.RefundRequest   the model, for looking up what is taken
 * @param {Function} deps.issueRmaNumber
 * @param {Date} [deps.now]
 */
async function issueRma(request, { RefundRequest, issueRmaNumber, now = new Date() }) {
  const rmaNumber = await issueRmaNumber({
    findLatest: async (year) => {
      const latest = await RefundRequest.findOne({
        rmaNumber: new RegExp(`^RMA-${year}-`),
      })
        .sort({ rmaNumber: -1 })
        .select("rmaNumber")
        .lean();
      return latest?.rmaNumber || null;
    },
    exists: async (candidate) => Boolean(await RefundRequest.exists({ rmaNumber: candidate })),
    now,
  });

  request.rmaNumber = rmaNumber;
  request.rma = {
    issuedAt: now,
    expiresAt: new Date(now.getTime() + RMA_EXPIRY_DAYS * DAY_MS),
    remindersSent: [],
  };

  return rmaNumber;
}

/**
 * Which reminder, if any, is due for this request right now.
 *
 * Returns the day number (7 or 12) or null. A reminder already in
 * `remindersSent` is never returned again, so re-running the daily job — after
 * a crash, or twice by mistake — cannot send the same email twice.
 *
 * The latest due reminder wins: a job that did not run for three days sends
 * day 12, not day 7 followed by day 12 tomorrow.
 */
function dueReminder(request, now = new Date()) {
  const issuedAt = request?.rma?.issuedAt;
  if (!issuedAt) return null;

  const sent = new Set(request.rma.remindersSent || []);
  const daysElapsed = Math.floor((now.getTime() - new Date(issuedAt).getTime()) / DAY_MS);

  const due = REMINDER_DAYS.filter((day) => daysElapsed >= day && !sent.has(day));

  return due.length ? Math.max(...due) : null;
}

/** Whether the authorisation has run out. */
function hasExpired(request, now = new Date()) {
  const expiresAt = request?.rma?.expiresAt;
  if (!expiresAt) return false;
  return now.getTime() > new Date(expiresAt).getTime();
}

module.exports = { issueRma, dueReminder, hasExpired, RMA_EXPIRY_DAYS, REMINDER_DAYS };
