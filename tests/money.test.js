const { round2 } = require("../src/utils/money");

describe("round2", () => {
  it("fixes the float drift a price times a quantity produces", () => {
    // 99.99 * 3 stores as 299.96999999999997 in IEEE-754 floating point.
    // This is the exact drift that lets a reconciliation stop balancing.
    expect(99.99 * 3).not.toBe(299.97);
    expect(round2(99.99 * 3)).toBe(299.97);
  });

  it("fixes drift from summing several already-rounded amounts", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("leaves a clean two-decimal figure unchanged", () => {
    expect(round2(10.5)).toBe(10.5);
    expect(round2(0)).toBe(0);
  });

  it("treats a missing or non-numeric value as zero rather than NaN", () => {
    expect(round2(undefined)).toBe(0);
    expect(round2(null)).toBe(0);
    expect(round2("not a number")).toBe(0);
  });
});
