// The twelve months after the thirty days.
//
// A return and a warranty claim look the same to a customer and are not the
// same thing. Getting it wrong either way is expensive: treating a month-eight
// fault as a return refunds a phone somebody has used for eight months;
// treating it as nothing means the warranty UpCell advertises does not exist.

const {
  WARRANTY_DAYS,
  WARRANTY_REASON_CODES,
  WARRANTY_OUTCOMES,
  warrantyExpiresAt,
  claimKind,
  isWarrantyReason,
  isWarrantyOutcome,
  checkWarrantyReason,
  warrantyRefundCents,
} = require("../src/services/warranty");

const DAY = 24 * 60 * 60 * 1000;
const DELIVERED = new Date("2026-01-10T12:00:00Z");
const daysAfterDelivery = (days) => new Date(DELIVERED.getTime() + days * DAY);

const order = (over = {}) => ({ paid: true, deliveredAt: DELIVERED, ...over });

describe("when the warranty runs out", () => {
  it("is twelve months from the day it arrived", () => {
    expect(warrantyExpiresAt(order())).toEqual(new Date(DELIVERED.getTime() + WARRANTY_DAYS * DAY));
  });

  it("counts from delivery, not from the order date", () => {
    // A parcel that sat in a depot for a week should not eat a week of cover.
    const late = order({ createdAt: new Date("2026-01-01T00:00:00Z") });

    expect(warrantyExpiresAt(late)).toEqual(new Date(DELIVERED.getTime() + WARRANTY_DAYS * DAY));
  });

  it("falls back to the shipping estimate when nobody recorded delivery", () => {
    const shipped = new Date("2026-01-07T12:00:00Z");
    const expected = new Date(shipped.getTime() + (3 + WARRANTY_DAYS) * DAY);

    expect(warrantyExpiresAt({ paid: true, shippedAt: shipped })).toEqual(expected);
  });

  it("has not started on an order that has not shipped", () => {
    // Which is not the same as having expired.
    expect(warrantyExpiresAt({ paid: true })).toBeNull();
  });

  it("follows a staff override, like the return window does", () => {
    const actual = new Date("2026-02-01T00:00:00Z");
    const result = warrantyExpiresAt(order(), { override: { startDate: actual } });

    expect(result).toEqual(new Date(actual.getTime() + WARRANTY_DAYS * DAY));
  });
});

describe("which kind of claim this is", () => {
  it("is a return inside the thirty days", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(5) }).kind).toBe("RETURN");
  });

  it("is still a return on the last day", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(30) }).kind).toBe("RETURN");
  });

  it("becomes a warranty claim the day after", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(31) }).kind).toBe("WARRANTY");
  });

  it("is a warranty claim in month eight", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(240) }).kind).toBe("WARRANTY");
  });

  it("is still a warranty claim on the last day of the year", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(365) }).kind).toBe("WARRANTY");
  });

  it("is expired the day after that", () => {
    expect(claimKind(order(), { now: daysAfterDelivery(366) }).kind).toBe("EXPIRED");
  });

  it("says the clock has not started rather than that it has run out", () => {
    expect(claimKind({ paid: true }).kind).toBe("NOT_STARTED");
  });

  it("reports both dates whichever kind it is", () => {
    // A customer in month eight needs to know when the return window shut and
    // when the warranty ends, not just that one of them applies.
    const result = claimKind(order(), { now: daysAfterDelivery(100) });

    expect(result.closesAt).toEqual(daysAfterDelivery(30));
    expect(result.warrantyEndsAt).toEqual(daysAfterDelivery(365));
  });
});

describe("what a warranty covers", () => {
  it("covers hardware faults", () => {
    expect(isWarrantyReason("WONT_POWER_ON")).toBe(true);
    expect(isWarrantyReason("SCREEN_OR_TOUCH")).toBe(true);
    expect(isWarrantyReason("OVERHEATING")).toBe(true);
  });

  it("does not cover a change of mind", () => {
    // Eight months is not a change of mind, it is a used phone.
    expect(isWarrantyReason("CHANGED_MIND")).toBe(false);
    expect(isWarrantyReason("FOUND_BETTER_PRICE")).toBe(false);
  });

  it("does not cover UpCell sending the wrong thing", () => {
    // A wrong model is noticed in the first week, and belongs to the return
    // window. Eight months later it is not a fulfilment problem any more.
    expect(isWarrantyReason("WRONG_MODEL")).toBe(false);
    expect(isWarrantyReason("NOT_AS_DESCRIBED")).toBe(false);
  });

  it("does not cover anything about the delivery", () => {
    expect(isWarrantyReason("ARRIVED_LATE")).toBe(false);
    expect(isWarrantyReason("NEVER_ARRIVED")).toBe(false);
  });

  it("excludes the faults that are claims about arrival", () => {
    // A phone cannot be damaged in transit in month eight, and it cannot
    // arrive Activation Locked eight months after it arrived.
    expect(isWarrantyReason("PHYSICAL_DAMAGE_ON_ARRIVAL")).toBe(false);
    expect(isWarrantyReason("ACTIVATION_LOCKED")).toBe(false);
  });

  it("does not cover a reason nobody wrote down", () => {
    expect(isWarrantyReason("OTHER")).toBe(false);
    expect(isWarrantyReason(undefined)).toBe(false);
  });

  it("lists a real set of codes rather than an empty one", () => {
    // Derived from the reason list, so an empty array here would silently
    // refuse every warranty claim and every test above would still pass.
    expect(WARRANTY_REASON_CODES.length).toBeGreaterThanOrEqual(5);
    expect(WARRANTY_REASON_CODES).toContain("BATTERY_ISSUE");
  });
});

describe("telling a customer why not", () => {
  it("asks for a reason before anything else", () => {
    const result = checkWarrantyReason(null);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reason_required");
  });

  it("names both dates, so the customer knows which one is the problem", () => {
    // Told only "not eligible", somebody in month eight cannot tell whether
    // the reason they picked or the time that passed is what stopped them.
    const { message } = checkWarrantyReason("CHANGED_MIND", {
      closesAt: daysAfterDelivery(30),
      warrantyEndsAt: daysAfterDelivery(365),
    });

    expect(message).toContain("30-day return window closed");
    expect(message).toContain("warranty runs until");
  });

  it("says what the warranty does cover, not only what it does not", () => {
    const { message } = checkWarrantyReason("CHANGED_MIND", {});

    expect(message).toContain("will not power on");
  });

  it("passes a hardware fault", () => {
    expect(checkWarrantyReason("WONT_POWER_ON", {}).ok).toBe(true);
  });
});

describe("what a warranty claim pays", () => {
  it("pays nothing for a repair", () => {
    // The customer gets a working phone back, which is what was promised.
    // Paying as well would be paying twice.
    expect(warrantyRefundCents("REPAIR", { orderItemCents: 49900 })).toBe(0);
  });

  it("pays nothing for a replacement", () => {
    expect(warrantyRefundCents("REPLACE", { orderItemCents: 49900 })).toBe(0);
  });

  it("pays out only when somebody chose the exception", () => {
    expect(warrantyRefundCents("REFUND_EXCEPTION", { orderItemCents: 49900 })).toBe(49900);
  });

  it("pays nothing when no outcome has been decided", () => {
    expect(warrantyRefundCents(null, { orderItemCents: 49900 })).toBe(0);
    expect(warrantyRefundCents(undefined, { orderItemCents: 49900 })).toBe(0);
  });

  it("never pays a negative amount", () => {
    expect(warrantyRefundCents("REFUND_EXCEPTION", { orderItemCents: -100 })).toBe(0);
  });

  it("pays nothing when the amount is missing", () => {
    expect(warrantyRefundCents("REFUND_EXCEPTION", {})).toBe(0);
  });
});

describe("the outcomes staff can record", () => {
  it("is repair, replace, or refund as an exception", () => {
    expect(WARRANTY_OUTCOMES).toEqual(["REPAIR", "REPLACE", "REFUND_EXCEPTION"]);
  });

  it("refuses anything else", () => {
    expect(isWarrantyOutcome("REPAIR")).toBe(true);
    expect(isWarrantyOutcome("REFUND")).toBe(false);
    expect(isWarrantyOutcome("")).toBe(false);
  });
});
