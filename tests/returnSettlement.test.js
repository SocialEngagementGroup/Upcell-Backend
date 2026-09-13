const {
  SETTLEMENT_METHODS,
  defaultMethodFor,
  validateSettlement,
  outcomeFor,
} = require("../src/services/returnSettlement");

describe("defaultMethodFor", () => {
  it("refunds a cash order in cash", () => {
    expect(defaultMethodFor({ paidWith: "Manual" })).toBe("CASH");
  });

  it("refunds a card order back to the card", () => {
    // Refunding by a different route from the payment is how money goes
    // missing and how a refund becomes untraceable.
    expect(defaultMethodFor({ paidWith: "Card" })).toBe("ORIGINAL_PAYMENT");
    expect(defaultMethodFor({ paidWith: "BankOfAmerica" })).toBe("ORIGINAL_PAYMENT");
  });

  it("falls back to a transfer for anything else", () => {
    expect(defaultMethodFor({})).toBe("BANK_TRANSFER");
  });
});

describe("validateSettlement", () => {
  const cash = {
    method: "CASH",
    amount: 849.15,
    receiptUrl: "https://cdn/receipt.jpg",
    expectedAmount: 849.15,
  };
  const transfer = {
    method: "BANK_TRANSFER",
    amount: 849.15,
    reference: "TRF-99182",
    expectedAmount: 849.15,
  };

  it("accepts a cash handover with a signed receipt", () => {
    expect(validateSettlement(cash).ok).toBe(true);
  });

  it("refuses a cash handover without one", () => {
    // A cash refund has no bank record behind it. The receipt is the only
    // evidence a specific person received a specific amount.
    const result = validateSettlement({ ...cash, receiptUrl: "" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signed receipt/i);
  });

  it("accepts a transfer with a bank reference", () => {
    expect(validateSettlement(transfer).ok).toBe(true);
  });

  it("refuses a transfer without one", () => {
    // Nothing to match against a statement when the customer says it never
    // arrived.
    const result = validateSettlement({ ...transfer, reference: "  " });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bank reference/i);
  });

  it("refuses paying more than was agreed", () => {
    const result = validateSettlement({ ...transfer, amount: 900 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/more than the \$849\.15 agreed/);
  });

  it("allows paying less, which happens and stays visible", () => {
    expect(validateSettlement({ ...transfer, amount: 400 }).ok).toBe(true);
  });

  it("tolerates a cent of rounding rather than blocking an exact payment", () => {
    expect(validateSettlement({ ...transfer, amount: 849.15, expectedAmount: 849.1499 }).ok)
      .toBe(true);
  });

  it("refuses a zero or negative amount", () => {
    for (const amount of [0, -10]) {
      expect(validateSettlement({ ...transfer, amount }).ok).toBe(false);
    }
  });

  it("refuses a method that does not exist", () => {
    expect(validateSettlement({ ...transfer, method: "CRYPTO" }).ok).toBe(false);
  });

  it("rounds the recorded amount to cents", () => {
    const result = validateSettlement({ ...transfer, amount: 849.148, expectedAmount: 1000 });

    expect(result.settlement.settlementAmount).toBe(849.15);
  });

  it("offers all three methods", () => {
    expect(SETTLEMENT_METHODS).toEqual(["CASH", "BANK_TRANSFER", "ORIGINAL_PAYMENT"]);
  });
});

describe("outcomeFor", () => {
  it("calls a straightforward settlement a full refund", () => {
    expect(outcomeFor({ timeline: [] })).toBe("FULL_REFUND");
  });

  it("recognises one that went through a revised offer", () => {
    // Derived from how it got here, so it is right whether or not anyone
    // remembered to record it.
    const request = { timeline: [{ event: "revised_offer_accepted" }] };

    expect(outcomeFor(request)).toBe("PARTIAL_ACCEPTED");
  });

  it("keeps an outcome that was already decided", () => {
    const request = {
      resolution: { outcome: "PARTIAL_DECLINED" },
      timeline: [{ event: "revised_offer_declined" }],
    };

    expect(outcomeFor(request)).toBe("PARTIAL_DECLINED");
  });
});
