const {
  validateDisposition,
  relistDevice,
  internalRecordFor,
} = require("../src/services/returnDisposition");
const {
  DISPOSITION_TYPES,
  RELISTING_DISPOSITIONS,
  relists,
  reprices,
  sourceAllows,
} = require("../src/constants/dispositions");

describe("the five routes", () => {
  it("offers all five", () => {
    expect(DISPOSITION_TYPES).toEqual([
      "RELIST", "RELIST_REGRADED", "RETURN_TO_SUPPLIER", "WHOLESALE", "SCRAP",
    ]);
  });

  it("puts a device back on sale only by relisting it", () => {
    expect(RELISTING_DISPOSITIONS).toEqual(["RELIST", "RELIST_REGRADED"]);
    for (const type of ["RETURN_TO_SUPPLIER", "WHOLESALE", "SCRAP"]) {
      expect(relists(type)).toBe(false);
    }
  });

  it("re-prices only when the grade dropped", () => {
    expect(reprices("RELIST_REGRADED")).toBe(true);
    expect(reprices("RELIST")).toBe(false);
  });
});

describe("acquisition source", () => {
  it("refuses the supplier route for a device bought from an individual", () => {
    // There is nobody to send it back to.
    const result = sourceAllows("RETURN_TO_SUPPLIER", "INDIVIDUAL");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bought from an individual/i);
  });

  it("allows it for bulk stock", () => {
    expect(sourceAllows("RETURN_TO_SUPPLIER", "BULK").ok).toBe(true);
  });

  it("allows it when the source is not recorded", () => {
    // The field is new and most of the catalogue is not filled in. Blocking a
    // legitimate route on every existing device would cost real recovery
    // value, so only a source known to be an individual blocks it.
    expect(sourceAllows("RETURN_TO_SUPPLIER", "UNKNOWN").ok).toBe(true);
    expect(sourceAllows("RETURN_TO_SUPPLIER", undefined).ok).toBe(true);
  });

  it("does not restrict any other route by source", () => {
    for (const type of ["RELIST", "RELIST_REGRADED", "WHOLESALE", "SCRAP"]) {
      expect(sourceAllows(type, "INDIVIDUAL").ok).toBe(true);
    }
  });
});

describe("validateDisposition", () => {
  const relist = { type: "RELIST", grade: "EXCELLENT" };

  it("accepts a relist at a grade", () => {
    expect(validateDisposition(relist).ok).toBe(true);
  });

  it("demands a grade on every route", () => {
    // Whoever handles it next needs it, and it cannot be recovered once the
    // device has left the bench.
    for (const type of DISPOSITION_TYPES) {
      const result = validateDisposition({ type, grade: "", reason: "a reason", price: 100 });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/grade/i);
    }
  });

  it("refuses a grade that is not on the scale", () => {
    expect(validateDisposition({ ...relist, grade: "B" }).ok).toBe(false);
  });

  it("demands a price when the grade dropped", () => {
    // The system knows it fell from Excellent to Good. It does not know what
    // a Good one of these is worth this month.
    const result = validateDisposition({ type: "RELIST_REGRADED", grade: "GOOD" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/new price/i);
  });

  it("accepts a re-grade with one", () => {
    const result = validateDisposition({ type: "RELIST_REGRADED", grade: "GOOD", price: 499 });

    expect(result.ok).toBe(true);
    expect(result.disposition.price).toBe(499);
  });

  it("does not ask for a price on a plain relist", () => {
    expect(validateDisposition(relist).disposition.price).toBeUndefined();
  });

  it("demands a reason before writing a device off", () => {
    const result = validateDisposition({ type: "SCRAP", grade: "FAIL" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it("refuses the supplier route for an individual's device before anything else", () => {
    const result = validateDisposition({
      type: "RETURN_TO_SUPPLIER", grade: "FAIL", reason: "DOA within terms",
      acquisitionSource: "INDIVIDUAL",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/individual/i);
  });

  it("rounds a re-graded price to the cent", () => {
    const result = validateDisposition({
      type: "RELIST_REGRADED", grade: "GOOD", price: 499.987,
    });

    expect(result.disposition.price).toBe(499.99);
  });
});

describe("relistDevice", () => {
  const model = (modifiedCount) => ({ updateOne: jest.fn(async () => ({ modifiedCount })) });

  it("puts the unit's own listing back up", () => {
    const SingleVariation = model(1);

    return relistDevice({
      SingleVariation, productId: "p1", disposition: { type: "RELIST", grade: "EXCELLENT" },
    }).then((result) => {
      expect(result.ok).toBe(true);
      const [filter, update] = SingleVariation.updateOne.mock.calls[0];
      expect(filter._id).toBe("p1");
      expect(update.$set.outOfStock).toBe(false);
      expect(update.$set.cosmeticGrade).toBe("EXCELLENT");
    });
  });

  it("never touches a different unit's listing", () => {
    // With per-unit records this is the failure worth designing against: a
    // filter matching a model or a grade rather than an id would relist a
    // shelf of devices that are not back.
    const SingleVariation = model(1);

    return relistDevice({
      SingleVariation, productId: "p1", disposition: { type: "RELIST", grade: "GOOD" },
    }).then(() => {
      const [filter] = SingleVariation.updateOne.mock.calls[0];

      expect(filter._id).toBe("p1");
      expect(Object.keys(filter).sort()).toEqual(["_id", "isAccessory"]);
    });
  });

  it("re-prices in the same write as it relists", async () => {
    // A listing live at the old price for even a moment is a listing somebody
    // can buy.
    const SingleVariation = model(1);

    await relistDevice({
      SingleVariation,
      productId: "p1",
      disposition: { type: "RELIST_REGRADED", grade: "GOOD", price: 499 },
    });

    const [, update] = SingleVariation.updateOne.mock.calls[0];
    expect(update.$set.price).toBe(499);
    expect(update.$set.cosmeticGrade).toBe("GOOD");
    expect(update.$set.outOfStock).toBe(false);
  });

  it("does not touch the price on a plain relist", async () => {
    const SingleVariation = model(1);

    await relistDevice({
      SingleVariation, productId: "p1", disposition: { type: "RELIST", grade: "EXCELLENT" },
    });

    expect(SingleVariation.updateOne.mock.calls[0][1].$set.price).toBeUndefined();
  });

  it("clears the stale reservation from the checkout that sold it", async () => {
    const SingleVariation = model(1);

    await relistDevice({
      SingleVariation, productId: "p1", disposition: { type: "RELIST", grade: "GOOD" },
    });

    const [, update] = SingleVariation.updateOne.mock.calls[0];
    expect(update.$set.reservedUntil).toBeNull();
    expect(update.$set.reservedFor).toBeNull();
  });

  it("refuses to relist anything that is not a relist", async () => {
    for (const type of ["WHOLESALE", "SCRAP", "RETURN_TO_SUPPLIER"]) {
      const SingleVariation = model(1);

      const result = await relistDevice({
        SingleVariation, productId: "p1", disposition: { type, grade: "GOOD" },
      });

      expect(result.ok).toBe(false);
      expect(SingleVariation.updateOne).not.toHaveBeenCalled();
    }
  });

  it("reports when nothing changed rather than claiming success", async () => {
    const result = await relistDevice({
      SingleVariation: model(0), productId: "p1", disposition: { type: "RELIST", grade: "GOOD" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be put back on sale/i);
  });
});

describe("internalRecordFor", () => {
  const request = {
    rmaNumber: "RMA-2026-00412",
    itemIds: ["p1"],
    inspection: { finalGrade: "GOOD" },
    device: { imei: "353916000000000" },
  };

  it("carries what whoever handles it next needs", () => {
    const record = internalRecordFor(request, { type: "WHOLESALE", grade: "FAIR" });

    expect(record).toMatchObject({
      rmaNumber: "RMA-2026-00412",
      disposition: "WHOLESALE",
      label: "Wholesale",
      grade: "FAIR",
      imei: "353916000000000",
      productId: "p1",
    });
  });

  it("falls back to the grade inspection worked out", () => {
    expect(internalRecordFor(request, { type: "WHOLESALE" }).grade).toBe("GOOD");
  });

  it("keeps the reason on a write-off", () => {
    const record = internalRecordFor(request, {
      type: "SCRAP", grade: "FAIL", reason: "Water damaged",
    });

    expect(record.reason).toBe("Water damaged");
  });
});
