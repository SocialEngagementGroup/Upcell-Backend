// Reading a spreadsheet of devices.
//
// Every row is one physical phone on a shelf. A row read wrong is not a
// formatting problem — it is a device nobody can find, or one entered twice
// and sold to two people.

const {
  parseCsv,
  checkHeaders,
  readRow,
  duplicatesWithin,
} = require("../src/services/productImport");

const Q = String.fromCharCode(34);
const BOM = String.fromCharCode(0xfeff);

describe("splitting the file up", () => {
  it("reads a plain file", () => {
    const { headers, rows } = parseCsv("modelName,price\niPhone 13,499\n");

    expect(headers).toEqual(["modelName", "price"]);
    expect(rows).toEqual([["iPhone 13", "499"]]);
  });

  it("reads Windows line endings, which is what a spreadsheet writes", () => {
    const { rows } = parseCsv("modelName,price\r\niPhone 13,499\r\n");

    expect(rows).toEqual([["iPhone 13", "499"]]);
  });

  it("keeps a comma that is inside quotes", () => {
    // Otherwise "1,299" becomes two columns and every column after it shifts.
    const { rows } = parseCsv(`modelName,price\niPhone 13,${Q}1,299${Q}\n`);

    expect(rows).toEqual([["iPhone 13", "1,299"]]);
  });

  it("reads a doubled quote as one quote", () => {
    const { rows } = parseCsv(`modelName,price\n${Q}13${Q}${Q} Pro${Q},499\n`);

    expect(rows[0][0]).toBe(`13${Q} Pro`);
  });

  it("keeps a newline that is inside quotes", () => {
    const { rows } = parseCsv(`modelName,price\n${Q}iPhone\n13${Q},499\n`);

    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("iPhone\n13");
  });

  it("strips the byte order mark Excel writes", () => {
    // Without this the first column is named "﻿modelName", never matches,
    // and every row in the file fails for no visible reason.
    const { headers } = parseCsv(`${BOM}modelName,price\niPhone 13,499\n`);

    expect(headers[0]).toBe("modelName");
  });

  it("reads a last row with no newline after it", () => {
    const { rows } = parseCsv("modelName,price\niPhone 13,499");

    expect(rows).toEqual([["iPhone 13", "499"]]);
  });

  it("skips blank lines rather than importing empty devices", () => {
    const { rows } = parseCsv("modelName,price\n\niPhone 13,499\n\n");

    expect(rows).toEqual([["iPhone 13", "499"]]);
  });

  it("gives nothing back for an empty file", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("\n\n")).toEqual({ headers: [], rows: [] });
  });
});

describe("checking the header row", () => {
  it("accepts the columns it needs", () => {
    expect(checkHeaders(["modelName", "price"]).ok).toBe(true);
  });

  it("names what is missing, so it can be fixed in one go", () => {
    const result = checkHeaders(["storage", "color"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("modelName");
    expect(result.error).toContain("price");
  });

  it("ignores a column it does not know", () => {
    // A spreadsheet somebody keeps for their own use has a notes column, and
    // refusing the file over it means maintaining two copies of one list.
    expect(checkHeaders(["modelName", "price", "notes"]).ok).toBe(true);
  });
});

const HEADERS = [
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

const row = (over = {}) => {
  const values = {
    modelName: "iPhone 13",
    storage: "128GB",
    color: "Midnight",
    price: "499",
    cosmeticGrade: "GOOD",
    batteryHealth: "92",
    carrierStatus: "Unlocked",
    imei: "123456789012345",
    serialNumber: "",
    ...over,
  };
  return HEADERS.map((name) => values[name]);
};

const read = (over, options) => readRow(HEADERS, row(over), { categoryName: "iPhone", ...options });

describe("reading one row", () => {
  it("accepts a complete row", () => {
    const { errors, value } = read();

    expect(errors).toEqual([]);
    expect(value).toMatchObject({
      modelName: "iPhone 13",
      storage: "128GB",
      price: 499,
      cosmeticGrade: "GOOD",
      batteryHealth: 92,
      carrierStatus: "UNLOCKED",
      imei: "123456789012345",
    });
  });

  it("refuses a row with no price rather than importing a free phone", () => {
    // Number("") is 0, not NaN, which is exactly how this goes wrong.
    const { errors, value } = read({ price: "" });

    expect(errors).toContain("price is empty");
    expect(value).toBeUndefined();
  });

  it("refuses a price of zero", () => {
    expect(read({ price: "0" }).errors).toContain("price must be more than 0");
  });

  it("reads a price somebody typed with a dollar sign and a comma", () => {
    expect(read({ price: "$1,299" }).value.price).toBe(1299);
  });

  it("refuses a price that is not a number", () => {
    expect(read({ price: "ask Yasir" }).errors[0]).toContain("is not a number");
  });

  it("refuses a grade that is not on the scale", () => {
    const { errors } = read({ cosmeticGrade: "Mint" });

    expect(errors[0]).toContain("Mint");
    expect(errors[0]).toContain("EXCELLENT");
  });

  it("accepts a grade in any case, because a person typed it", () => {
    expect(read({ cosmeticGrade: "good" }).value.cosmeticGrade).toBe("GOOD");
  });

  it("allows a row with no grade at all", () => {
    expect(read({ cosmeticGrade: "" }).errors).toEqual([]);
  });

  it("reads a battery written with a percent sign", () => {
    expect(read({ batteryHealth: "92%" }).value.batteryHealth).toBe(92);
  });

  it("treats a missing battery reading as missing, not as zero", () => {
    // A blank cell is not a dead battery, and Number("") is 0.
    const { errors, value } = read({ batteryHealth: "" });

    expect(errors).toEqual([]);
    expect(value.batteryHealth).toBeUndefined();
    expect(value.refurbState).toBe("SELLABLE");
  });

  it("refuses a battery reading outside 0 to 100", () => {
    expect(read({ batteryHealth: "140" }).errors[0]).toContain("between 0 and 100");
  });

  it("marks a device under 80% as needing a battery, not as sellable", () => {
    // It works and it is in the building. It still must not be listed.
    expect(read({ batteryHealth: "79" }).value.refurbState).toBe("NEEDS_BATTERY");
  });

  it("treats exactly 80% as sellable", () => {
    expect(read({ batteryHealth: "80" }).value.refurbState).toBe("SELLABLE");
  });

  it("reads a carrier the way somebody writes it", () => {
    expect(read({ carrierStatus: "T-Mobile" }).value.carrierStatus).toBe("TMOBILE");
    expect(read({ carrierStatus: "t mobile" }).value.carrierStatus).toBe("TMOBILE");
  });

  it("assumes unlocked when the column is blank", () => {
    expect(read({ carrierStatus: "" }).value.carrierStatus).toBe("UNLOCKED");
  });

  it("refuses a carrier it does not recognise", () => {
    expect(read({ carrierStatus: "Three UK" }).errors[0]).toContain("Three UK");
  });

  it("refuses an IMEI that is not 15 digits", () => {
    // A 14-digit number is a mistyped one, and a device whose number does not
    // match is a device that cannot be checked against its own order.
    expect(read({ imei: "12345678901234" }).errors[0]).toContain("15 digits");
    expect(read({ imei: "12345678901234X" }).errors[0]).toContain("15 digits");
  });

  it("allows a row with no IMEI when identity is not being enforced", () => {
    expect(read({ imei: "" }).errors).toEqual([]);
  });

  it("demands an IMEI for a phone once identity is enforced", () => {
    const { errors } = read({ imei: "" }, { identityRequired: true });

    expect(errors).toContain("imei is required for a phone");
  });

  it("demands a serial for a laptop, not an IMEI", () => {
    // Apple uses two numbers and a MacBook only has one of them. Demanding
    // both is how a rule turns into something staff work around.
    const { errors } = readRow(HEADERS, row({ imei: "", serialNumber: "" }), {
      categoryName: "MacBook Pro",
      identityRequired: true,
    });

    expect(errors).toContain("serialNumber is required for a tablet or laptop");
    expect(errors).not.toContain("imei is required for a phone");
  });

  it("refuses a serial with punctuation in it", () => {
    expect(read({ serialNumber: "C02-1234" }).errors[0]).toContain("does not look like a serial");
  });

  it("reports every problem in a row at once", () => {
    // Being told about one mistake per upload is how a 200-row file takes a
    // week to import.
    const { errors } = read({ modelName: "", price: "", cosmeticGrade: "Mint" });

    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("records that the stock arrived in bulk", () => {
    // Which is what decides whether a return can go back to a supplier.
    expect(read().value.acquisitionSource).toBe("BULK");
  });

  it("works out the device type from the product's category", () => {
    expect(read().value.deviceType).toBe("PHONE");
    expect(readRow(HEADERS, row(), { categoryName: "iPad Air" }).value.deviceType).toBe("TABLET");
  });

  it("leaves the device type unset rather than guessing", () => {
    expect(readRow(HEADERS, row(), { categoryName: "Widgets" }).value.deviceType).toBeUndefined();
  });

  it("trims what a spreadsheet pads", () => {
    expect(read({ modelName: "  iPhone 13  " }).value.modelName).toBe("iPhone 13");
  });

  it("copes with a column the file does not have", () => {
    const short = ["modelName", "price"];
    const { errors, value } = readRow(short, ["iPhone 13", "499"], { categoryName: "iPhone" });

    expect(errors).toEqual([]);
    expect(value.storage).toBeUndefined();
    expect(value.carrierStatus).toBe("UNLOCKED");
  });
});

describe("the same device on two rows", () => {
  const entry = (line, value) => ({ line, value });

  it("finds an IMEI repeated in the file", () => {
    const clashes = duplicatesWithin([
      entry(2, { imei: "123456789012345" }),
      entry(7, { imei: "123456789012345" }),
    ]);

    // Reported against the second one, pointing back at the first, because
    // that is the order somebody reads their spreadsheet in.
    expect(clashes.get(7)).toContain("line 2");
    expect(clashes.has(2)).toBe(false);
  });

  it("finds a repeated serial too", () => {
    const clashes = duplicatesWithin([
      entry(2, { serialNumber: "C02ABC123" }),
      entry(3, { serialNumber: "C02ABC123" }),
    ]);

    expect(clashes.get(3)).toContain("line 2");
  });

  it("does not treat two blank identities as the same device", () => {
    // Most of the catalogue has neither number. Every accessory always will.
    const clashes = duplicatesWithin([
      entry(2, { imei: undefined, serialNumber: undefined }),
      entry(3, { imei: undefined, serialNumber: undefined }),
    ]);

    expect(clashes.size).toBe(0);
  });

  it("does not confuse an IMEI with a serial that reads the same", () => {
    const clashes = duplicatesWithin([
      entry(2, { imei: "123456789012345" }),
      entry(3, { serialNumber: "123456789012345" }),
    ]);

    expect(clashes.size).toBe(0);
  });
});
