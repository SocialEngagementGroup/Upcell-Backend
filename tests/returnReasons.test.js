const {
  RETURN_REASONS,
  RETURN_REASON_CODES,
  isReturnReasonCode,
  reasonCategory,
  returnWindowDays,
  faultAttributionFor,
  customerPaysInboundPostage,
  restockingFeeApplies,
  returnPolicyFor,
} = require("../src/constants/returnReasons");

describe("return reasons — the code decides the policy", () => {
  it("puts every code in a category, except OTHER", () => {
    for (const code of RETURN_REASON_CODES) {
      if (code === "OTHER") continue;
      expect(reasonCategory(code)).toBeTruthy();
    }
  });

  it("gives every code a label a customer can read", () => {
    for (const code of RETURN_REASON_CODES) {
      expect(RETURN_REASONS[code].label).toEqual(expect.any(String));
      expect(RETURN_REASONS[code].label.length).toBeGreaterThan(0);
    }
  });

  it("rejects a code that does not exist", () => {
    expect(isReturnReasonCode("MADE_UP")).toBe(false);
    expect(reasonCategory("MADE_UP")).toBeNull();
  });
});

describe("return window", () => {
  it("gives change-of-mind 14 days", () => {
    expect(returnWindowDays("CHANGED_MIND")).toBe(14);
    expect(returnWindowDays("FOUND_BETTER_PRICE")).toBe(14);
    expect(returnWindowDays("NO_LONGER_NEEDED")).toBe(14);
  });

  it("gives a faulty or wrong device 30 days", () => {
    expect(returnWindowDays("WONT_POWER_ON")).toBe(30);
    expect(returnWindowDays("WRONG_MODEL")).toBe(30);
    expect(returnWindowDays("ARRIVED_DAMAGED_BOX")).toBe(30);
  });

  it("gives OTHER and unknown codes the longer window, never the shorter", () => {
    // Cutting someone off early because the reason list did not fit their case
    // is the wrong way to be wrong.
    expect(returnWindowDays("OTHER")).toBe(30);
    expect(returnWindowDays("MADE_UP")).toBe(30);
    expect(returnWindowDays(undefined)).toBe(30);
  });
});

describe("fault attribution and who pays postage", () => {
  it("blames the customer only for changing their mind", () => {
    expect(faultAttributionFor("CHANGED_MIND")).toBe("CUSTOMER");
    expect(customerPaysInboundPostage("CHANGED_MIND")).toBe(true);
  });

  it("blames UpCell for its own mistakes, faults and logistics", () => {
    for (const code of ["WRONG_MODEL", "WONT_POWER_ON", "NEVER_ARRIVED", "NOT_AS_DESCRIBED"]) {
      expect(faultAttributionFor(code)).toBe("UPCELL");
      expect(customerPaysInboundPostage(code)).toBe(false);
    }
  });

  it("refuses to guess for OTHER", () => {
    // null is not a failure here. It means a person has to read the note and
    // decide, and a guess would silently settle who pays.
    expect(faultAttributionFor("OTHER")).toBeNull();
    expect(faultAttributionFor("MADE_UP")).toBeNull();
  });
});

describe("restocking fee", () => {
  it("applies to change-of-mind returns", () => {
    expect(restockingFeeApplies("CHANGED_MIND")).toBe(true);
    expect(restockingFeeApplies("FOUND_BETTER_PRICE")).toBe(true);
    expect(restockingFeeApplies("NO_LONGER_NEEDED")).toBe(true);
  });

  it("never applies when the device is faulty, wrong, or arrived damaged", () => {
    // This is the live bug it replaces: the fee was charged on everything
    // unless staff waived it, so a broken phone cost the customer 15%.
    const upcellsFault = [
      "WONT_POWER_ON", "BATTERY_ISSUE", "SCREEN_OR_TOUCH", "CAMERA_ISSUE",
      "NETWORK_OR_SIM", "OVERHEATING", "ACTIVATION_LOCKED", "PHYSICAL_DAMAGE_ON_ARRIVAL",
      "WRONG_MODEL", "WRONG_STORAGE", "WRONG_COLOR", "MISSING_ITEMS", "NOT_AS_DESCRIBED",
      "ARRIVED_LATE", "ARRIVED_DAMAGED_BOX", "NEVER_ARRIVED",
    ];

    for (const code of upcellsFault) {
      expect(restockingFeeApplies(code)).toBe(false);
    }
  });

  it("does not apply to OTHER or an unknown code", () => {
    expect(restockingFeeApplies("OTHER")).toBe(false);
    expect(restockingFeeApplies("MADE_UP")).toBe(false);
  });
});

describe("returnPolicyFor — everything about one reason in one call", () => {
  it("describes a change-of-mind return", () => {
    expect(returnPolicyFor("CHANGED_MIND")).toEqual({
      code: "CHANGED_MIND",
      known: true,
      category: "PREFERENCE",
      windowDays: 14,
      faultAttribution: "CUSTOMER",
      customerPaysPostage: true,
      restockingFee: true,
      requiresNote: false,
    });
  });

  it("describes a faulty device", () => {
    expect(returnPolicyFor("WONT_POWER_ON")).toEqual({
      code: "WONT_POWER_ON",
      known: true,
      category: "PRODUCT_FAULT",
      windowDays: 30,
      faultAttribution: "UPCELL",
      customerPaysPostage: false,
      restockingFee: false,
      requiresNote: false,
    });
  });

  it("marks OTHER as needing a note and an undecided attribution", () => {
    const policy = returnPolicyFor("OTHER");

    expect(policy.requiresNote).toBe(true);
    expect(policy.faultAttribution).toBeNull();
    expect(policy.known).toBe(true);
  });

  it("reports an unknown code as unknown rather than throwing", () => {
    const policy = returnPolicyFor("MADE_UP");

    expect(policy.known).toBe(false);
    expect(policy.restockingFee).toBe(false);
  });
});
