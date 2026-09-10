const {
  deviceTypeFromCategory,
  hasIdentity,
  identityRequired,
  IDENTIFIER_FOR,
} = require("../src/constants/deviceIdentity");

// Every unit is its own catalogue row, so the identity on that row is the only
// thing tying a physical device to the order that sold it, the return that
// brought it back and the trade-in it arrived on.
describe("what identifies a device", () => {
  it("asks a phone for its IMEI and a laptop for its serial", () => {
    // Demanding both would make the check something staff work around, which
    // is worse than demanding the one the device actually displays.
    expect(IDENTIFIER_FOR.PHONE).toBe("imei");
    expect(IDENTIFIER_FOR.TABLET).toBe("serialNumber");
    expect(IDENTIFIER_FOR.LAPTOP).toBe("serialNumber");
  });

  it("asks an accessory for nothing", () => {
    // A case is not a device. It has no identity and never will.
    expect(IDENTIFIER_FOR.ACCESSORY).toBeNull();
    expect(hasIdentity({ deviceType: "ACCESSORY" }).ok).toBe(true);
  });

  it("accepts a phone with an IMEI and refuses one without", () => {
    expect(hasIdentity({ deviceType: "PHONE", imei: "353916000000000" }).ok).toBe(true);

    const missing = hasIdentity({ deviceType: "PHONE" });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toBe("imei");
    expect(missing.error).toMatch(/IMEI/);
  });

  it("does not accept a serial in place of an IMEI", () => {
    // A phone with only a serial recorded has not been identified the way a
    // phone is identified, and the check has to say so.
    expect(hasIdentity({ deviceType: "PHONE", serialNumber: "C02X1234" }).ok).toBe(false);
  });

  it("treats whitespace as missing", () => {
    expect(hasIdentity({ deviceType: "PHONE", imei: "   " }).ok).toBe(false);
  });

  it("falls back to the category when the type has not been set", () => {
    // The 956 rows that predate the field. Reading the category is what let
    // the backfill classify every one of them.
    expect(hasIdentity({ categoryName: "iPhone Pro" }).ok).toBe(false);
    expect(hasIdentity({ categoryName: "iPhone Pro", imei: "353916000000000" }).ok).toBe(true);
  });

  it("demands nothing of a row it cannot classify", () => {
    // Better to let an unclassified row through than to demand an IMEI of
    // something that may not be a phone at all.
    expect(hasIdentity({ categoryName: "Something New" }).ok).toBe(true);
    expect(hasIdentity({}).ok).toBe(true);
  });
});

describe("classifying by category", () => {
  it("maps every category the catalogue actually has", () => {
    // All ten, checked against the real spread on 11 Sep 2026.
    const expected = {
      "iPhone": "PHONE", "iPhone Pro": "PHONE", "iPhone Pro Max": "PHONE", "iPhone Plus": "PHONE",
      "iPad": "TABLET", "iPad Air": "TABLET", "iPad Pro": "TABLET", "iPad mini": "TABLET",
      "MacBook Pro": "LAPTOP", "MacBook Air": "LAPTOP",
    };

    for (const [category, type] of Object.entries(expected)) {
      expect([category, deviceTypeFromCategory(category)]).toEqual([category, type]);
    }
  });

  it("calls an accessory an accessory whatever its category says", () => {
    expect(deviceTypeFromCategory("iPhone", { isAccessory: true })).toBe("ACCESSORY");
    expect(deviceTypeFromCategory(null, { isAccessory: true })).toBe("ACCESSORY");
  });

  it("returns null rather than guessing", () => {
    // Filing a Mac as a phone would then demand an IMEI it will never have.
    expect(deviceTypeFromCategory("Apple Watch")).toBeNull();
    expect(deviceTypeFromCategory("")).toBeNull();
    expect(deviceTypeFromCategory(null)).toBeNull();
  });

  it("ignores case, because a category name is typed by a person", () => {
    expect(deviceTypeFromCategory("IPHONE PRO")).toBe("PHONE");
    expect(deviceTypeFromCategory("macbook air")).toBe("LAPTOP");
  });
});

describe("the grace flag", () => {
  const withFlag = (value, fn) => {
    const saved = process.env.IDENTITY_REQUIRED;
    if (value === undefined) delete process.env.IDENTITY_REQUIRED;
    else process.env.IDENTITY_REQUIRED = value;
    try { fn(); } finally {
      if (saved === undefined) delete process.env.IDENTITY_REQUIRED;
      else process.env.IDENTITY_REQUIRED = saved;
    }
  };

  it("is off unless it says exactly true", () => {
    // 954 of 956 rows have no identity recorded. Anything looser than an exact
    // match risks turning enforcement on by accident and refusing checkout for
    // almost the whole shop.
    for (const value of [undefined, "", "false", "1", "yes", "TRUE"]) {
      withFlag(value, () => expect(identityRequired()).toBe(false));
    }
  });

  it("is on when it does", () => {
    withFlag("true", () => expect(identityRequired()).toBe(true));
  });

  it("is read per call, so a deploy takes effect without a reload", () => {
    withFlag("true", () => expect(identityRequired()).toBe(true));
    withFlag("false", () => expect(identityRequired()).toBe(false));
  });
});
