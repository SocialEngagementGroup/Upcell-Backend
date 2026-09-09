const {
  validateDisposition,
  restockDevice,
  internalRecordFor,
} = require("../src/services/returnDisposition");
const {
  DISPOSITION_TYPES,
  RESTOCKING_DISPOSITIONS,
  restocks,
} = require("../src/constants/dispositions");

describe("the five routes", () => {
  it("offers all five", () => {
    expect(DISPOSITION_TYPES).toEqual([
      "RESTOCK_NEW", "OPEN_BOX", "RETURN_TO_SUPPLIER", "WHOLESALE", "SCRAP",
    ]);
  });

  it("puts only a sealed device back on sale", () => {
    // Automatically listing an opened phone as new is the mistake the whole
    // disposition model exists to prevent.
    expect(RESTOCKING_DISPOSITIONS).toEqual(["RESTOCK_NEW"]);
    for (const type of ["OPEN_BOX", "WHOLESALE", "RETURN_TO_SUPPLIER", "SCRAP"]) {
      expect(restocks(type)).toBe(false);
    }
  });

  it("keeps OPEN_BOX as its own route rather than merging it into wholesale", () => {
    // Handled as wholesale today, but recorded distinctly so the decision is a
    // change to where it routes, not a rebuild.
    expect(DISPOSITION_TYPES).toContain("OPEN_BOX");
    expect(DISPOSITION_TYPES).toContain("WHOLESALE");
  });
});

describe("validateDisposition", () => {
  it("accepts a sealed device going back to stock", () => {
    expect(validateDisposition({ type: "RESTOCK_NEW" }).ok).toBe(true);
  });

  it("does not demand a grade for something going back on sale as new", () => {
    // Its grade is "new" by definition — the seal was never broken.
    expect(validateDisposition({ type: "RESTOCK_NEW", grade: undefined }).ok).toBe(true);
  });

  it("demands a grade for anything leaving the returns queue", () => {
    // Whoever handles it next needs it, and it cannot be recovered once the
    // device has left the bench.
    for (const type of ["OPEN_BOX", "WHOLESALE"]) {
      const result = validateDisposition({ type, grade: "" });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/grade/i);
    }
  });

  it("demands a reason before writing a device off", () => {
    // One that vanishes without a reason is indistinguishable from one that
    // walked.
    const result = validateDisposition({ type: "SCRAP", grade: "FAIL" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it("accepts a scrap with one", () => {
    expect(validateDisposition({
      type: "SCRAP", grade: "FAIL", reason: "Board is water damaged beyond repair",
    }).ok).toBe(true);
  });

  it("asks which supplier terms a return-to-supplier is going under", () => {
    const result = validateDisposition({ type: "RETURN_TO_SUPPLIER", grade: "FAIL" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/supplier terms/i);
  });

  it("refuses a route that does not exist", () => {
    expect(validateDisposition({ type: "BIN_IT", grade: "C" }).ok).toBe(false);
  });

  it("trims what it stores", () => {
    const result = validateDisposition({
      type: "WHOLESALE", grade: "  B  ", imei: "  353916...  ",
    });

    expect(result.disposition.grade).toBe("B");
    expect(result.disposition.imei).toBe("353916...");
  });
});

describe("restockDevice", () => {
  const model = (modifiedCount) => ({
    updateOne: jest.fn(async () => ({ modifiedCount })),
  });

  it("puts a sealed device back on sale", async () => {
    const SingleVariation = model(1);

    const result = await restockDevice({
      SingleVariation, productId: "p1", dispositionType: "RESTOCK_NEW",
    });

    expect(result.ok).toBe(true);
    const [filter, update] = SingleVariation.updateOne.mock.calls[0];
    expect(filter._id).toBe("p1");
    expect(update.$set.outOfStock).toBe(false);
  });

  it("clears the stale reservation from the checkout that sold it", async () => {
    const SingleVariation = model(1);

    await restockDevice({ SingleVariation, productId: "p1", dispositionType: "RESTOCK_NEW" });

    const [, update] = SingleVariation.updateOne.mock.calls[0];
    expect(update.$set.reservedUntil).toBeNull();
    expect(update.$set.reservedFor).toBeNull();
  });

  it("only touches devices, matching how they are taken off sale", async () => {
    const SingleVariation = model(1);

    await restockDevice({ SingleVariation, productId: "p1", dispositionType: "RESTOCK_NEW" });

    expect(SingleVariation.updateOne.mock.calls[0][0].isAccessory).toEqual({ $ne: true });
  });

  it("refuses to restock anything but a sealed device", async () => {
    // This function is one line away from listing a scrapped phone as new.
    for (const type of ["OPEN_BOX", "WHOLESALE", "SCRAP", "RETURN_TO_SUPPLIER"]) {
      const SingleVariation = model(1);

      const result = await restockDevice({ SingleVariation, productId: "p1", dispositionType: type });

      expect(result.ok).toBe(false);
      expect(SingleVariation.updateOne).not.toHaveBeenCalled();
    }
  });

  it("reports when nothing changed, rather than claiming success", async () => {
    // Already on sale, or the product was deleted while the return was in
    // flight. A staff member has to know the shelf did not change.
    const result = await restockDevice({
      SingleVariation: model(0), productId: "p1", dispositionType: "RESTOCK_NEW",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be put back on sale/i);
  });

  it("refuses when there is no product to restock", async () => {
    const result = await restockDevice({
      SingleVariation: model(1), productId: undefined, dispositionType: "RESTOCK_NEW",
    });

    expect(result.ok).toBe(false);
  });
});

describe("internalRecordFor", () => {
  const request = {
    rmaNumber: "RMA-2026-00412",
    itemIds: ["p1"],
    inspection: { grade: "B" },
    device: { imei: "353916000000000" },
  };

  it("carries what whoever handles it next needs", () => {
    const record = internalRecordFor(request, { type: "WHOLESALE", grade: "C" });

    expect(record).toMatchObject({
      rmaNumber: "RMA-2026-00412",
      disposition: "WHOLESALE",
      label: "Wholesale",
      grade: "C",
      imei: "353916000000000",
      productId: "p1",
    });
  });

  it("falls back to the inspection grade when none was given", () => {
    expect(internalRecordFor(request, { type: "OPEN_BOX" }).grade).toBe("B");
  });

  it("keeps the reason on a write-off", () => {
    const record = internalRecordFor(request, {
      type: "SCRAP", grade: "FAIL", reason: "Water damaged",
    });

    expect(record.reason).toBe("Water damaged");
  });
});
