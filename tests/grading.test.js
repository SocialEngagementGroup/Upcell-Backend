const {
  GRADES,
  BELOW_GRADE,
  batteryBand,
  lowerGrade,
  finalGrade,
  regradeOnReturn,
  isDeductibleFinding,
} = require("../src/constants/grading");

// The boundaries staff read off a screen, so they are worth being exact about
// rather than approximately right.
describe("battery band", () => {
  it("100% is Excellent", () => expect(batteryBand(100)).toBe(GRADES.EXCELLENT));
  it("90% is Excellent", () => expect(batteryBand(90)).toBe(GRADES.EXCELLENT));
  it("89% is Good", () => expect(batteryBand(89)).toBe(GRADES.GOOD));
  it("85% is Good", () => expect(batteryBand(85)).toBe(GRADES.GOOD));
  it("84% is Fair", () => expect(batteryBand(84)).toBe(GRADES.FAIR));
  it("80% is Fair", () => expect(batteryBand(80)).toBe(GRADES.FAIR));
  it("79% is below grade", () => expect(batteryBand(79)).toBe(BELOW_GRADE));

  it("is not a grade at all when no reading was taken", () => {
    // Distinct from a bad reading. A missing number must not fail a device.
    expect(batteryBand(undefined)).toBeNull();
    expect(batteryBand(null)).toBeNull();
    expect(batteryBand("not a number")).toBeNull();
  });
});

describe("lowerGrade", () => {
  it("picks the worse of two", () => {
    expect(lowerGrade(GRADES.EXCELLENT, GRADES.FAIR)).toBe(GRADES.FAIR);
    expect(lowerGrade(GRADES.FAIR, GRADES.EXCELLENT)).toBe(GRADES.FAIR);
  });

  it("returns the one it has when the other is missing", () => {
    expect(lowerGrade(GRADES.GOOD, undefined)).toBe(GRADES.GOOD);
    expect(lowerGrade(undefined, GRADES.GOOD)).toBe(GRADES.GOOD);
  });
});

describe("final grade", () => {
  it("is Excellent only when both axes are", () => {
    expect(finalGrade({ batteryHealth: 95, cosmeticGrade: GRADES.EXCELLENT }))
      .toBe(GRADES.EXCELLENT);
  });

  it("takes the cosmetic grade when it is the worse one", () => {
    // A great battery does not rescue a scratched phone — the customer opening
    // the box sees the scratches.
    expect(finalGrade({ batteryHealth: 95, cosmeticGrade: GRADES.FAIR })).toBe(GRADES.FAIR);
  });

  it("takes the battery band when it is the worse one", () => {
    expect(finalGrade({ batteryHealth: 82, cosmeticGrade: GRADES.EXCELLENT })).toBe(GRADES.FAIR);
  });

  it("fails on a cracked screen whatever the battery says", () => {
    expect(finalGrade({ batteryHealth: 100, cosmeticGrade: GRADES.FAIL })).toBe(GRADES.FAIL);
  });

  it("fails a battery under 80%, which is not listable at any grade", () => {
    expect(finalGrade({ batteryHealth: 75, cosmeticGrade: GRADES.EXCELLENT })).toBe(GRADES.FAIL);
  });

  it("stands on the cosmetic grade alone when no battery reading exists", () => {
    // An older listing, or a device that would not power on to be read.
    expect(finalGrade({ cosmeticGrade: GRADES.GOOD })).toBe(GRADES.GOOD);
  });
});

describe("regrade on return", () => {
  it("relists a device that came back as it left", () => {
    const result = regradeOnReturn({ gradeAtSale: GRADES.EXCELLENT, cosmeticGrade: GRADES.EXCELLENT });

    expect(result).toMatchObject({ disposition: "RELIST", regraded: false });
  });

  it("regrades one that came back worse", () => {
    const result = regradeOnReturn({ gradeAtSale: GRADES.EXCELLENT, cosmeticGrade: GRADES.GOOD });

    expect(result).toMatchObject({
      disposition: "RELIST_REGRADED", regraded: true, from: GRADES.EXCELLENT, to: GRADES.GOOD,
    });
  });

  it("does not regrade one that came back better than it sold at", () => {
    // The listing said Good and the customer paid the Good price. Raising it
    // now would be marking up a device somebody already bought and returned.
    const result = regradeOnReturn({ gradeAtSale: GRADES.GOOD, cosmeticGrade: GRADES.EXCELLENT });

    expect(result).toMatchObject({ disposition: "RELIST", regraded: false, to: GRADES.GOOD });
  });

  it("scraps one that came back cracked", () => {
    const result = regradeOnReturn({ gradeAtSale: GRADES.EXCELLENT, cosmeticGrade: GRADES.FAIL });

    expect(result.disposition).toBe("SCRAP");
  });

  it("relists at the grade found when nothing was recorded at sale", () => {
    const result = regradeOnReturn({ gradeAtSale: undefined, cosmeticGrade: GRADES.GOOD });

    expect(result).toMatchObject({ disposition: "RELIST", to: GRADES.GOOD });
    expect(result.reason).toMatch(/no grade was recorded/i);
  });
});

// The rule the whole file exists for.
describe("a battery drop is never damage", () => {
  it("does not regrade a device whose battery fell but which looks the same", () => {
    // Sold at 90%, back at 88%. Nothing about how it looks has changed.
    const result = regradeOnReturn({ gradeAtSale: GRADES.EXCELLENT, cosmeticGrade: GRADES.EXCELLENT });

    expect(result.disposition).toBe("RELIST");
    expect(result.regraded).toBe(false);
  });

  it("does not regrade even on a nine-point drop", () => {
    // Sold at 90%, back at 81% — two battery bands lower, and still RELIST,
    // because regrading reads the cosmetic axis and nothing else.
    const result = regradeOnReturn({ gradeAtSale: GRADES.EXCELLENT, cosmeticGrade: GRADES.EXCELLENT });

    expect(result.disposition).toBe("RELIST");
  });

  it("refuses a deduction that mentions the battery", () => {
    // Refused outright, not merely unsuggested: staff can type any amount they
    // like, and "battery is down to 82%" is a reason someone writes in good
    // faith.
    const result = isDeductibleFinding({
      findingKey: "battery_health", reason: "Battery down to 82%",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/normal wear/i);
  });

  it("refuses it however the word is spelled into the reason", () => {
    for (const reason of ["Battery worn", "battery capacity low", "BATTERY DEGRADED"]) {
      expect(isDeductibleFinding({ findingKey: "other", reason }).ok).toBe(false);
    }
  });

  it("allows a deduction for real physical damage", () => {
    expect(isDeductibleFinding({
      findingKey: "cosmetic_grade", reason: "Deep scratch across the back",
    }).ok).toBe(true);
  });
});
