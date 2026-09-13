// The identity of one physical device.
//
// Every UpCell device is a single unit, and until now nothing in the system
// said *which* unit. The returns inspection already asks staff to tick "IMEI /
// serial matches the order", but there was no IMEI on the order to match it
// against, so the tick meant only that somebody looked. The Return Policy page
// promises customers that a returned device "must match our sales records" —
// this is the field that makes that sentence true.
//
// Two identifiers, because Apple uses two. A phone or a cellular iPad has an
// IMEI: fifteen digits, the last one a Luhn check digit, the same scheme card
// numbers use. A wifi iPad, a MacBook or a Watch has no IMEI at all, only a
// serial number. Both are optional everywhere — an accessory has neither, and
// most of the existing catalogue was entered before this existed.

// Printed with spaces or dashes on a box and read back without them. Stored
// bare so two records of the same device can never look different.
const normalizeImei = (value) => String(value ?? "").replace(/[\s-]/g, "").trim();

// Apple serials are 10-12 characters, alphanumeric, and are quoted in upper
// case everywhere Apple prints them. Older formats run shorter, so the bound is
// deliberately loose — this is a typo check, not a specification.
const normalizeSerial = (value) =>
  String(value ?? "").replace(/[\s-]/g, "").trim().toUpperCase();

// The Luhn check digit. Catches a single mistyped digit and almost every
// transposed pair, which is what actually goes wrong when somebody copies
// fifteen digits off the back of a box.
function luhnPasses(digits) {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

const isValidImei = (value) => {
  const digits = normalizeImei(value);
  return /^\d{15}$/.test(digits) && luhnPasses(digits);
};

const isValidSerial = (value) => /^[A-Z0-9]{8,20}$/.test(normalizeSerial(value));

// An empty box is not an error — it is a device nobody has recorded yet, or an
// accessory that has no identifier to record. Returning undefined rather than
// "" matters: the unique indexes on these fields are partial on the field being
// a string, and a stored empty string would collide with every other one.
const cleanImei = (value) => {
  const digits = normalizeImei(value);
  return digits ? digits : undefined;
};

const cleanSerial = (value) => {
  const serial = normalizeSerial(value);
  return serial ? serial : undefined;
};

/**
 * Does the device on the bench match what the order says was sold?
 *
 * Deliberately not a strict "both must match": staff read whichever identifier
 * the device shows them. A phone shows an IMEI, a MacBook shows a serial, and
 * demanding the other one would make the check something to be worked around.
 *
 * @returns {"match" | "mismatch" | "unknown"} — "unknown" when the order never
 *   recorded an identifier, which is every order placed before this existed.
 *   That is not a pass and not a failure, and must not be reported as either.
 */
function matchesSoldDevice({ imei, serial } = {}, expected = []) {
  const known = expected.filter((item) => item?.imei || item?.serial);
  if (!known.length) return "unknown";

  const readImei = cleanImei(imei);
  const readSerial = cleanSerial(serial);
  if (!readImei && !readSerial) return "unknown";

  const hit = known.some(
    (item) =>
      (readImei && cleanImei(item.imei) === readImei) ||
      (readSerial && cleanSerial(item.serial) === readSerial)
  );

  return hit ? "match" : "mismatch";
}

module.exports = {
  normalizeImei,
  normalizeSerial,
  isValidImei,
  isValidSerial,
  cleanImei,
  cleanSerial,
  matchesSoldDevice,
};
