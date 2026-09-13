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
  it("gives every reason 30 days", () => {
    // It used to be 14 for a change of mind. That made the shorter window
    // depend on a customer correctly classifying their own problem, and put
    // UpCell below the policy its customers compare it against.
    for (const code of RETURN_REASON_CODES) {
      expect(returnWindowDays(code)).toBe(30);
    }
  });

  it("gives 30 days for an unknown or absent code too", () => {
    expect(returnWindowDays("MADE_UP")).toBe(30);
    expect(returnWindowDays(undefined)).toBe(30);
  });
});

describe("fault attribution", () => {
  it("still separates the customer's choice from UpCell's mistake", () => {
    // It no longer changes what anyone pays. It is what makes a pattern of
    // bad-faith returns visible when inspection overturns it.
    expect(faultAttributionFor("CHANGED_MIND")).toBe("CUSTOMER");
    expect(faultAttributionFor("WONT_POWER_ON")).toBe("UPCELL");
    expect(faultAttributionFor("NEVER_ARRIVED")).toBe("UPCELL");
  });

  it("refuses to guess for OTHER", () => {
    expect(faultAttributionFor("OTHER")).toBeNull();
    expect(faultAttributionFor("MADE_UP")).toBeNull();
  });
});

describe("what the customer pays", () => {
  it("charges nobody for postage, whatever the reason", () => {
    for (const code of RETURN_REASON_CODES) {
      expect(customerPaysInboundPostage(code)).toBe(false);
    }
  });

  it("charges no restocking fee, whatever the reason", () => {
    for (const code of RETURN_REASON_CODES) {
      expect(restockingFeeApplies(code)).toBe(false);
    }
  });
});

describe("returnPolicyFor — everything about one reason in one call", () => {
  it("describes a change-of-mind return", () => {
    expect(returnPolicyFor("CHANGED_MIND")).toEqual({
      code: "CHANGED_MIND",
      known: true,
      category: "PREFERENCE",
      windowDays: 30,
      faultAttribution: "CUSTOMER",
      // Free either way now, and said out loud rather than left to inference.
      customerPaysPostage: false,
      restockingFee: false,
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
