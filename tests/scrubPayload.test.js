const { scrubPayload } = require("../src/utils/scrubPayload");

// The bank's reply is worth keeping as dispute evidence, but storing it
// verbatim would put card data on this server — which is the one thing the
// hosted payment page exists to prevent.

describe("scrubPayload — keeping card data out of the database", () => {
  it("keeps the ordinary fields untouched", () => {
    const safe = scrubPayload({
      decision: "ACCEPT",
      reason_code: "100",
      transaction_id: "7882749437566123004007",
      auth_amount: "1109.50",
      auth_avs_code: "Y",
      req_reference_number: "6a79f7298341f33d9a65b0b7",
    });

    expect(safe.decision).toBe("ACCEPT");
    expect(safe.auth_amount).toBe("1109.50");
    expect(safe.transaction_id).toBe("7882749437566123004007");
    expect(safe.req_reference_number).toBe("6a79f7298341f33d9a65b0b7");
  });

  it("removes the security code entirely, not masked", () => {
    // PCI forbids keeping the CVN after authorisation in any form.
    const safe = scrubPayload({ req_card_cvn: "123", card_cvv: "4567", decision: "ACCEPT" });

    expect(safe.req_card_cvn).toBe("[removed]");
    expect(safe.card_cvv).toBe("[removed]");
    expect(JSON.stringify(safe)).not.toContain("123");
    expect(JSON.stringify(safe)).not.toContain("4567");
  });

  it("reduces a card number to the last four digits", () => {
    const safe = scrubPayload({ req_card_number: "4111111111111111" });

    expect(safe.req_card_number).toBe("xxxx1111");
    expect(JSON.stringify(safe)).not.toContain("4111111111111111");
  });

  it("leaves an already-masked number readable", () => {
    const safe = scrubPayload({ req_card_number: "xxxxxxxxxxxx1111" });

    expect(safe.req_card_number).toBe("xxxx1111");
  });

  it("catches a full card number hiding in an unexpected field", () => {
    // Fails closed: a field the gateway adds later must not leak a PAN just
    // because nobody added it to a list.
    const safe = scrubPayload({ some_new_field: "customer paid with 4111111111111111 today" });

    expect(safe.some_new_field).toBe("customer paid with xxxx1111 today");
  });

  it("does not mangle short numbers like amounts or ZIP codes", () => {
    const safe = scrubPayload({ auth_amount: "1109.50", postal: "94043", reason_code: "100" });

    expect(safe.auth_amount).toBe("1109.50");
    expect(safe.postal).toBe("94043");
    expect(safe.reason_code).toBe("100");
  });

  it("scrubs nested objects too", () => {
    const safe = scrubPayload({ card: { number: "4111111111111111", cvn: "123" } });

    expect(safe.card.number).toBe("xxxx1111");
    expect(safe.card.cvn).toBe("[removed]");
  });

  it("survives junk input without throwing", () => {
    expect(scrubPayload(null)).toEqual({});
    expect(scrubPayload(undefined)).toEqual({});
    expect(scrubPayload("a string")).toEqual({});
    expect(scrubPayload({ empty: undefined, nothing: null })).toEqual({ empty: "", nothing: "" });
  });
});
