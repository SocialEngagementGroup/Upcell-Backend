// RMA numbers: "RMA-2026-00412".
//
// The number a customer writes on a box and quotes in an email, so it has to be
// readable aloud, hard to mistype, and obviously not an order number. It is not
// a security token — the tracking page is protected by ownership or an
// unguessable token, never by the RMA being hard to guess.
//
// Sequential within a year rather than random, because staff read these in a
// queue and a run of them should sort in the order they arrived. The year
// resets the counter, which keeps the number short for a decade.

const RMA_PREFIX = "RMA";
const SEQUENCE_PAD = 5;

const rmaPattern = /^RMA-(\d{4})-(\d+)$/;

const formatRma = (year, sequence) =>
  `${RMA_PREFIX}-${year}-${String(sequence).padStart(SEQUENCE_PAD, "0")}`;

const parseRma = (value) => {
  const match = rmaPattern.exec(String(value || "").trim().toUpperCase());
  if (!match) return null;
  return { year: Number(match[1]), sequence: Number(match[2]) };
};

// The next number for a year, given the highest already issued in it.
//
// Split out from the database call so the counting rule can be tested on its
// own, and so the caller decides how it reads "highest" — which matters,
// because two requests created in the same moment must not be handed the same
// number. The unique index on rmaNumber is what actually enforces that; this
// just has to be correct for one caller at a time.
function nextRmaNumber(latestRma, now = new Date()) {
  const year = now.getUTCFullYear();
  const parsed = parseRma(latestRma);

  // A number from a previous year does not carry over — January starts at 1.
  const sequence = parsed && parsed.year === year ? parsed.sequence + 1 : 1;

  return formatRma(year, sequence);
}

// Issues the next number, retrying on a duplicate.
//
// `findLatest(year)` returns the highest rmaNumber issued in that year, or
// null. `exists(candidate)` says whether that number is already taken. Two
// requests submitted in the same instant can both read the same "latest" and
// both compute the same next number; the loser of that race retries rather than
// failing the customer's return.
//
// Bounded rather than a while(true) for the same reason ensureUniqueSlug is:
// a bug that makes exists() always true should surface as an error, not hang
// the request forever.
async function issueRmaNumber({ findLatest, exists, now = new Date(), maxAttempts = 25 }) {
  const year = now.getUTCFullYear();
  let candidate = nextRmaNumber(await findLatest(year), now);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!(await exists(candidate))) return candidate;
    candidate = nextRmaNumber(candidate, now);
  }

  throw new Error(`Could not issue an RMA number after ${maxAttempts} attempts`);
}

module.exports = { formatRma, parseRma, nextRmaNumber, issueRmaNumber, RMA_PREFIX };
