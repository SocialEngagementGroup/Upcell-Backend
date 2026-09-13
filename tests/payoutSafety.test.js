// Keeping account numbers out of a phone shop's database.
//
// The failure this guards against is mundane and near-certain: a customer
// types their full account number into a free text box, or a staff member
// pastes it into a note so they remember it. Nobody decided to store a bank
// account — it happened anyway, and now a phone shop's database is a payments
// database.

const {
  looksLikeAccountNumber,
  maskReference,
  ACCOUNT_NUMBER_MESSAGE,
} = require("../src/services/payoutSafety");

describe("spotting an account number", () => {
  it("catches a bare account number", () => {
    expect(looksLikeAccountNumber("123456789")).toBe(true);
    expect(looksLikeAccountNumber("12345678901")).toBe(true);
  });

  it("catches a card number written the way people write it", () => {
    // Spaces and dashes are how these are actually typed.
    expect(looksLikeAccountNumber("4417 2938 1102 5544")).toBe(true);
    expect(looksLikeAccountNumber("4417-2938-1102-5544")).toBe(true);
  });

  it("catches one buried in a sentence", () => {
    expect(looksLikeAccountNumber("send it to 000123456789 please")).toBe(true);
  });

  it("leaves a name alone", () => {
    expect(looksLikeAccountNumber("Sam Okonkwo")).toBe(false);
  });

  it("leaves a Zelle handle alone", () => {
    expect(looksLikeAccountNumber("sam@example.com")).toBe(false);
  });

  it("leaves the last four digits alone", () => {
    // Which is the whole point — the safe form has to be accepted.
    expect(looksLikeAccountNumber("•••• 4417")).toBe(false);
    expect(looksLikeAccountNumber("ending 4417")).toBe(false);
  });

  it("allows a phone number, which is ten digits", () => {
    expect(looksLikeAccountNumber("313 288 8312")).toBe(true);
  });

  it("copes with nothing at all", () => {
    expect(looksLikeAccountNumber("")).toBe(false);
    expect(looksLikeAccountNumber(null)).toBe(false);
    expect(looksLikeAccountNumber(undefined)).toBe(false);
  });

  it("says what to do instead", () => {
    // Told only "invalid", somebody types it again with a space in it.
    expect(ACCOUNT_NUMBER_MESSAGE).toContain("last four");
  });
});

describe("reducing a reference to what is safe to keep", () => {
  it("keeps only the last four digits of an account", () => {
    expect(maskReference("123456789012", "BANK_TRANSFER")).toBe("•••• 9012");
  });

  it("strips the spaces before counting", () => {
    expect(maskReference("4417 2938 1102 5544", "BANK_TRANSFER")).toBe("•••• 5544");
  });

  it("leaves a Zelle handle as it is", () => {
    // Already something the customer published to UpCell, and shortening it
    // would make it useless for telling two of them apart.
    expect(maskReference("sam@example.com", "ZELLE")).toBe("sam@example.com");
  });

  it("keeps a short reference that has nothing to mask", () => {
    expect(maskReference("Pay to Sam", "CHECK")).toBe("Pay to Sam");
  });

  it("never returns more than four digits of an account", () => {
    const masked = maskReference("98765432109876", "BANK_TRANSFER");

    expect(masked).not.toContain("98765432");
    expect(masked.replace(/\D/g, "")).toHaveLength(4);
  });

  it("masks a number even when the method says cheque", () => {
    // A cheque reference with an account number in it is still an account
    // number. The method decides the shape, not whether to mask.
    expect(maskReference("000123456789", "CHECK")).toBe("•••• 6789");
  });

  it("gives back nothing for nothing", () => {
    expect(maskReference("", "ZELLE")).toBe("");
    expect(maskReference(null, "BANK_TRANSFER")).toBe("");
  });

  it("caps a very long handle rather than storing an essay", () => {
    expect(maskReference("a".repeat(500), "ZELLE")).toHaveLength(80);
  });
});
