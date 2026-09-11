// Reading a spreadsheet of devices into the catalogue.
//
// Every row here is one physical phone sitting on a shelf, and getting a row
// wrong is not a formatting problem — it is a device that cannot be found, or
// worse, one entered twice and sold to two people. So the rule throughout is
// that a bad row is reported by its line number and skipped, and a file can be
// run as a dry run first and read before anything is written.
//
// No parsing library. One is not worth a dependency for nine columns, and the
// quoting rules are small enough to state exactly (see parseCsv).

const { GRADES } = require("../constants/grading");
const {
  CARRIER_STATUSES,
  deviceTypeFromCategory,
  IDENTIFIER_FOR,
} = require("../constants/deviceIdentity");

const COLUMNS = [
  "modelName",
  "storage",
  "color",
  "price",
  "cosmeticGrade",
  "batteryHealth",
  "carrierStatus",
  "imei",
  "serialNumber",
];

const REQUIRED_COLUMNS = ["modelName", "price"];

// A file bigger than this is a mistake rather than an import. Five thousand
// rows of nine short columns sits well under it.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

const GRADE_NAMES = Object.keys(GRADES);

// Written this way so the character survives every layer of quoting between
// here and the file on disk.
const QUOTE = String.fromCharCode(34);

/**
 * Splits CSV text into a header row and data rows.
 *
 * Handles the three things a spreadsheet export actually does: fields wrapped
 * in double quotes so they can hold commas or newlines, a doubled quote
 * meaning one literal quote, and Windows line endings. A leading byte order
 * mark is stripped, because Excel writes one and it otherwise becomes part of
 * the first column's name — which then never matches "modelName" and makes
 * every row fail for no visible reason.
 */
function parseCsv(text) {
  const raw = String(text || "");
  // Excel writes a byte order mark. Compared by code point rather than
  // matched as a character, because an invisible character in source is
  // one that any editor or copy-paste can silently drop.
  const input = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char !== QUOTE) {
        field += char;
        continue;
      }
      // A doubled quote inside a quoted field is one literal quote.
      if (input[i + 1] === QUOTE) {
        field += QUOTE;
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === QUOTE && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ",") {
      endField();
      started = false;
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      continue;
    }

    field += char;
    started = true;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== "" || row.length) endRow();

  // A row of nothing but empty cells is a blank line, not a record.
  const meaningful = rows.filter((entry) => entry.some((value) => String(value).trim() !== ""));
  if (!meaningful.length) return { headers: [], rows: [] };

  const [headerRow, ...dataRows] = meaningful;

  return { headers: headerRow.map((name) => String(name).trim()), rows: dataRows };
}

/**
 * Whether the header row names the columns this import understands.
 *
 * Unknown columns are allowed and ignored. A spreadsheet somebody keeps for
 * their own use will have a notes column in it, and refusing the whole file
 * over that would mean asking them to maintain two copies of the same list.
 */
function checkHeaders(headers) {
  const present = new Set(headers);
  const missing = REQUIRED_COLUMNS.filter((name) => !present.has(name));

  if (missing.length) {
    return {
      ok: false,
      error: `The file is missing these columns: ${missing.join(", ")}. Expected: ${COLUMNS.join(", ")}`,
    };
  }

  return { ok: true };
}

const cell = (headers, row, name) => {
  const at = headers.indexOf(name);
  return at === -1 ? "" : String(row[at] ?? "").trim();
};

/**
 * Turns one row into something that can be saved, or into the list of reasons
 * it cannot be.
 *
 * Every reason names its column, so the error report can be read off the
 * screen and fixed in the spreadsheet without anybody opening this file.
 *
 * @returns {{errors: string[], value?: object}}
 */
function readRow(headers, row, { categoryName, identityRequired = false } = {}) {
  const errors = [];
  const get = (name) => cell(headers, row, name);

  const modelName = get("modelName");
  if (!modelName) errors.push("modelName is empty");

  // Checked as a string first, because Number("") is 0 rather than NaN and a
  // blank price would import as a free phone.
  const rawPrice = get("price");
  let price = null;
  if (rawPrice === "") {
    errors.push("price is empty");
  } else {
    price = Number(rawPrice.replace(/[$,]/g, ""));
    if (!Number.isFinite(price)) errors.push(`price "${rawPrice}" is not a number`);
    else if (price <= 0) errors.push("price must be more than 0");
  }

  const cosmeticGrade = get("cosmeticGrade").toUpperCase();
  if (cosmeticGrade && !GRADE_NAMES.includes(cosmeticGrade)) {
    errors.push(`cosmeticGrade "${get("cosmeticGrade")}" is not one of ${GRADE_NAMES.join(", ")}`);
  }

  const rawBattery = get("batteryHealth").replace(/%/g, "");
  let batteryHealth = null;
  if (rawBattery !== "") {
    const value = Number(rawBattery);
    if (!Number.isFinite(value)) errors.push(`batteryHealth "${get("batteryHealth")}" is not a number`);
    else if (value < 0 || value > 100) errors.push("batteryHealth must be between 0 and 100");
    else batteryHealth = value;
  }

  // Spaces and punctuation are stripped so "T-Mobile" and "T Mobile" both
  // reach TMOBILE. Whoever fills in a spreadsheet writes the carrier's name,
  // not the constant.
  const rawCarrier = get("carrierStatus").toUpperCase().replace(/[\s&-]/g, "");
  const carrierStatus = rawCarrier === "" ? "UNLOCKED" : rawCarrier;
  if (!CARRIER_STATUSES.includes(carrierStatus)) {
    errors.push(`carrierStatus "${get("carrierStatus")}" is not one of ${CARRIER_STATUSES.join(", ")}`);
  }

  // Fifteen digits, because that is what an IMEI is. A 14-digit number is a
  // mistyped one, and letting it through means the device on the bench never
  // matches the device on the order.
  const imei = get("imei");
  if (imei && !/^\d{15}$/.test(imei)) {
    errors.push(`imei "${imei}" is not 15 digits`);
  }

  const serialNumber = get("serialNumber");
  if (serialNumber && !/^[A-Za-z0-9]{6,20}$/.test(serialNumber)) {
    errors.push(`serialNumber "${serialNumber}" does not look like a serial (6-20 letters and digits)`);
  }

  const deviceType = deviceTypeFromCategory(categoryName);

  if (identityRequired && deviceType) {
    const needs = IDENTIFIER_FOR[deviceType];
    if (needs === "imei" && !imei) errors.push("imei is required for a phone");
    if (needs === "serialNumber" && !serialNumber) {
      errors.push("serialNumber is required for a tablet or laptop");
    }
  }

  if (errors.length) return { errors };

  return {
    errors: [],
    value: {
      modelName,
      storage: get("storage") || undefined,
      color: get("color") || undefined,
      price,
      cosmeticGrade: cosmeticGrade || undefined,
      batteryHealth: batteryHealth === null ? undefined : batteryHealth,
      carrierStatus,
      imei: imei || undefined,
      serialNumber: serialNumber || undefined,
      deviceType: deviceType || undefined,
      // A battery below 80% works and the device is in the building; it just
      // cannot be listed until the battery is replaced. Decided here rather
      // than left to a person, because the point of a bulk import is that
      // nobody reads 300 rows one at a time.
      refurbState: batteryHealth !== null && batteryHealth < 80 ? "NEEDS_BATTERY" : "SELLABLE",
      // Anything arriving by spreadsheet came in as stock, and that is what
      // decides whether a return can later go back to a supplier.
      acquisitionSource: "BULK",
    },
  };
}

/**
 * Finds devices listed twice in the same file.
 *
 * Separate from the database check because the two read differently to
 * whoever has to fix them: one is "your spreadsheet has this phone on two
 * rows", the other is "this phone is already in the catalogue".
 *
 * @returns {Map<number, string>} line number to the reason
 */
function duplicatesWithin(rows) {
  const seen = new Map();
  const clashes = new Map();

  rows.forEach(({ line, value }) => {
    ["imei", "serialNumber"].forEach((field) => {
      const key = value?.[field];
      if (!key) return;

      const id = `${field}:${key}`;
      if (seen.has(id)) clashes.set(line, `${field} ${key} is also on line ${seen.get(id)}`);
      else seen.set(id, line);
    });
  });

  return clashes;
}

module.exports = {
  COLUMNS,
  REQUIRED_COLUMNS,
  MAX_BYTES,
  MAX_ROWS,
  parseCsv,
  checkHeaders,
  readRow,
  duplicatesWithin,
};
