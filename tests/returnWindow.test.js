const {
  RETURN_WINDOW_DAYS,
  businessDaysBetween,
  resolveWindowStart,
  validateOverride,
  transitClaimInTime,
} = require("../src/services/returnWindow");

const day = (iso) => new Date(`${iso}T12:00:00Z`);
// 2026-09-10 is a Thursday, 2026-09-11 a Friday, 2026-09-14 a Monday.
const THU = day("2026-09-10");
const FRI = day("2026-09-11");
const SAT = day("2026-09-12");
const MON = day("2026-09-14");
const TUE = day("2026-09-15");
const WED = day("2026-09-16");
const THU2 = day("2026-09-17");

describe("window start date", () => {
  it("uses the delivery date when the carrier recorded one", () => {
    const window = resolveWindowStart({ deliveredAt: THU, shippedAt: MON });

    expect(window.startedFrom).toBe("DELIVERY");
    expect(window.startDate).toEqual(THU);
  });

  it("falls back to ship date plus three days when delivery was never recorded", () => {
    const window = resolveWindowStart({ shippedAt: day("2026-09-01") });

    expect(window.startedFrom).toBe("SHIP_PLUS_3");
    expect(window.startDate).toEqual(day("2026-09-04"));
  });

  it("never falls back to the order date", () => {
    // An order placed on the 1st and delivered on the 10th would quietly eat
    // nine days of the customer's window.
    const window = resolveWindowStart({ createdAt: day("2026-08-01") });

    expect(window).toBeNull();
  });

  it("says the window has not started rather than pretending it has", () => {
    // Not the same as expired. The customer has done nothing wrong.
    expect(resolveWindowStart({})).toBeNull();
    expect(resolveWindowStart(null)).toBeNull();
  });

  it("prefers a staff override to anything the record says", () => {
    // A person has information the record does not — usually the customer's
    // own email saying when it actually turned up.
    const window = resolveWindowStart(
      { deliveredAt: THU, shippedAt: MON },
      { override: { startDate: day("2026-09-05"), note: "Customer says it arrived on the 5th", by: "yasir@upcellit.com" } }
    );

    expect(window.startedFrom).toBe("STAFF_OVERRIDE");
    expect(window.startDate).toEqual(day("2026-09-05"));
    expect(window.overrideBy).toBe("yasir@upcellit.com");
  });

  it("closes the window 30 days after whichever date it started from", () => {
    const window = resolveWindowStart({ deliveredAt: day("2026-09-01") });

    expect(window.expiresAt).toEqual(day("2026-10-01"));
    expect(RETURN_WINDOW_DAYS).toBe(30);
  });
});

describe("staff override", () => {
  const valid = {
    startDate: day("2026-09-05"),
    note: "Customer emailed to say it arrived on the 5th",
    by: "yasir@upcellit.com",
  };

  it("accepts a dated override with a note", () => {
    expect(validateOverride(valid).ok).toBe(true);
  });

  it("refuses one with no note", () => {
    // Overriding this date decides whether a return is inside the window, so
    // it moves money. With two or three staff able to do it, an unexplained
    // override is indistinguishable from a favour.
    const result = validateOverride({ ...valid, note: "" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/say why/i);
  });

  it("refuses a note too short to mean anything", () => {
    expect(validateOverride({ ...valid, note: "ok" }).ok).toBe(false);
  });

  it("refuses a date in the future", () => {
    const result = validateOverride({
      ...valid,
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/future/i);
  });

  it("refuses a date that is not a date", () => {
    expect(validateOverride({ ...valid, startDate: "not a date" }).ok).toBe(false);
    expect(validateOverride({ ...valid, startDate: undefined }).ok).toBe(false);
  });

  it("keeps who did it, which is the whole point of asking", () => {
    expect(validateOverride(valid).override.by).toBe("yasir@upcellit.com");
  });
});

describe("business days between", () => {
  it("counts weekdays", () => {
    expect(businessDaysBetween(MON, TUE)).toBe(1);
    expect(businessDaysBetween(MON, WED)).toBe(2);
  });

  it("skips the weekend", () => {
    // Friday to Monday is one business day, not three.
    expect(businessDaysBetween(FRI, MON)).toBe(1);
  });

  it("is zero for the same day", () => {
    expect(businessDaysBetween(MON, MON)).toBe(0);
  });

  it("is zero when the end is before the start", () => {
    expect(businessDaysBetween(WED, MON)).toBe(0);
  });

  it("does not count a Saturday as a working day", () => {
    expect(businessDaysBetween(FRI, SAT)).toBe(0);
  });
});

describe("transit damage claims", () => {
  it("accepts a claim on the day of delivery", () => {
    expect(transitClaimInTime({ deliveredAt: MON }, { now: MON }).ok).toBe(true);
  });

  it("accepts one on the third business day", () => {
    expect(transitClaimInTime({ deliveredAt: MON }, { now: THU2 }).ok).toBe(true);
  });

  it("refuses one on the fourth business day", () => {
    const result = transitClaimInTime({ deliveredAt: MON }, { now: day("2026-09-18") });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/3 business days/);
  });

  it("gives a Friday delivery the same three working days as a Monday one", () => {
    // Delivered Friday, claimed the following Wednesday: Mon, Tue, Wed is
    // three business days, so it is in time even though five have passed.
    const result = transitClaimInTime({ deliveredAt: FRI }, { now: WED });

    expect(result.ok).toBe(true);
    expect(result.businessDaysElapsed).toBe(3);
  });

  it("does not refuse a claim on an order with no delivery recorded", () => {
    // The clock never started. Refusing would punish the customer for a
    // missing carrier scan.
    const result = transitClaimInTime({}, { now: MON });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no_delivery_recorded");
  });
});
