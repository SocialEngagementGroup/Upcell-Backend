const { formatRma, parseRma, nextRmaNumber, issueRmaNumber } = require("../src/utils/rma");

const jan2026 = new Date("2026-01-05T10:00:00Z");
const dec2026 = new Date("2026-12-31T23:00:00Z");

describe("RMA formatting", () => {
  it("pads to a fixed width so a queue sorts in the order it arrived", () => {
    expect(formatRma(2026, 412)).toBe("RMA-2026-00412");
    expect(formatRma(2026, 1)).toBe("RMA-2026-00001");
  });

  it("reads its own format back", () => {
    expect(parseRma("RMA-2026-00412")).toEqual({ year: 2026, sequence: 412 });
  });

  it("accepts what a customer would actually type", () => {
    // Lowercase from an email, spaces from a copy-paste.
    expect(parseRma("  rma-2026-00412 ")).toEqual({ year: 2026, sequence: 412 });
  });

  it("returns null for anything that is not an RMA", () => {
    for (const value of ["", null, undefined, "RMA-2026", "ORDER-2026-00412", "RMA-26-1", "12345"]) {
      expect(parseRma(value)).toBeNull();
    }
  });
});

describe("nextRmaNumber", () => {
  it("starts at 1 when nothing has been issued", () => {
    expect(nextRmaNumber(null, jan2026)).toBe("RMA-2026-00001");
  });

  it("counts on from the last one", () => {
    expect(nextRmaNumber("RMA-2026-00412", jan2026)).toBe("RMA-2026-00413");
  });

  it("restarts at 1 in a new year", () => {
    // Otherwise the number grows forever and stops being short enough to read
    // over the phone.
    expect(nextRmaNumber("RMA-2025-09999", jan2026)).toBe("RMA-2026-00001");
  });

  it("keeps counting past the padding width rather than wrapping", () => {
    expect(nextRmaNumber("RMA-2026-99999", jan2026)).toBe("RMA-2026-100000");
  });

  it("starts fresh when the last value is unreadable", () => {
    expect(nextRmaNumber("nonsense", jan2026)).toBe("RMA-2026-00001");
  });

  it("uses UTC, so an issue late on 31 December does not land in the wrong year", () => {
    expect(nextRmaNumber(null, dec2026)).toBe("RMA-2026-00001");
  });
});

describe("issueRmaNumber", () => {
  it("issues the next free number", async () => {
    const number = await issueRmaNumber({
      findLatest: async () => "RMA-2026-00007",
      exists: async () => false,
      now: jan2026,
    });

    expect(number).toBe("RMA-2026-00008");
  });

  it("steps past a number another request took first", async () => {
    // Two requests submitted in the same instant both read the same latest and
    // both compute the same next number. The loser retries rather than failing
    // the customer's return.
    const taken = new Set(["RMA-2026-00008", "RMA-2026-00009"]);

    const number = await issueRmaNumber({
      findLatest: async () => "RMA-2026-00007",
      exists: async (candidate) => taken.has(candidate),
      now: jan2026,
    });

    expect(number).toBe("RMA-2026-00010");
  });

  it("gives up rather than looping forever when every number looks taken", async () => {
    // A bug that makes exists() always true should surface as an error, not
    // hang the request.
    await expect(issueRmaNumber({
      findLatest: async () => "RMA-2026-00007",
      exists: async () => true,
      now: jan2026,
      maxAttempts: 5,
    })).rejects.toThrow(/after 5 attempts/);
  });

  it("asks for the latest number in the current year", async () => {
    const findLatest = jest.fn().mockResolvedValue(null);

    await issueRmaNumber({ findLatest, exists: async () => false, now: jan2026 });

    expect(findLatest).toHaveBeenCalledWith(2026);
  });
});
