const {
  buildRevisedOffer,
  offerExpiryFrom,
  offerHasExpired,
  OFFER_RESPONSE_DAYS,
} = require("../src/services/revisedOffer");
const { createAccessToken, tokenMatchesHash, hashToken } = require("../src/utils/accessToken");

const checklist = [
  { key: "cosmetic_grade", result: "fail" },
  { key: "screen_touch", result: "fail" },
  { key: "powers_on", result: "pass" },
  { key: "liquid_damage", result: "pass" },
];

const damage = (overrides = {}) => ({
  type: "DAMAGE",
  amount: 100,
  reason: "Deep scratch across the back",
  findingKey: "cosmetic_grade",
  // Every deduction needs a photograph now. A customer told their refund is
  // smaller has to be able to see why.
  photoIds: ["upcell/returns/photo-1"],
  ...overrides,
});

describe("buildRevisedOffer", () => {
  it("takes the deductions off and works out what is left", () => {
    const offer = buildRevisedOffer({ itemsTotal: 900, deductions: [damage()], checklist });

    expect(offer).toMatchObject({ ok: true, totalDeducted: 100, offeredAmount: 800 });
  });

  it("adds several deductions together", () => {
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage(), damage({ amount: 50, findingKey: "screen_touch" })],
      checklist,
    });

    expect(offer.offeredAmount).toBe(750);
  });

  it("refuses a deduction that names a check which passed", () => {
    // Worse than naming none: it looks evidenced when it is not.
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ findingKey: "powers_on" })],
      checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/did not fail/i);
  });

  it("refuses a deduction that names no check at all", () => {
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ findingKey: undefined })],
      checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/name the check/i);
  });

  it("refuses a deduction with no photograph", () => {
    // A finding with no picture behind it is an assertion, not evidence.
    const offer = buildRevisedOffer({
      itemsTotal: 900, deductions: [damage({ photoIds: [] })], checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/photo/i);
  });

  it("refuses a deduction for battery decline, however it is worded", () => {
    // The rule the grading policy turns on. Refused outright, because staff
    // can type any amount they like and this is a reason someone writes in
    // good faith.
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ reason: "Battery is down to 82%", findingKey: "cosmetic_grade" })],
      checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/normal wear/i);
  });

  it("refuses a deduction with no reason the customer can read", () => {
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ reason: "   " })],
      checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/reason/i);
  });

  it("refuses a zero or negative deduction", () => {
    for (const amount of [0, -50]) {
      expect(buildRevisedOffer({ itemsTotal: 900, deductions: [damage({ amount })], checklist }).ok)
        .toBe(false);
    }
  });

  it("refuses an offer with no deductions at all", () => {
    // That is a full refund, and it should be recorded as one.
    const offer = buildRevisedOffer({ itemsTotal: 900, deductions: [], checklist });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/full refund/i);
  });

  it("refuses to deduct more than the customer paid", () => {
    // A refund cannot become a bill. If the device is worth that little, the
    // answer is rejection.
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ amount: 1000 })],
      checklist,
    });

    expect(offer.ok).toBe(false);
    expect(offer.errors.join(" ")).toMatch(/Reject the return instead/i);
  });

  it("allows deducting the whole amount, which is different from more", () => {
    expect(buildRevisedOffer({
      itemsTotal: 900, deductions: [damage({ amount: 900 })], checklist,
    })).toMatchObject({ ok: true, offeredAmount: 0 });
  });

  it("refuses a kind of deduction that does not exist", () => {
    expect(buildRevisedOffer({
      itemsTotal: 900, deductions: [damage({ type: "VIBES" })], checklist,
    }).ok).toBe(false);
  });

  it("rounds to cents rather than carrying floating point noise", () => {
    const offer = buildRevisedOffer({
      itemsTotal: 100, deductions: [damage({ amount: 33.333 })], checklist,
    });

    expect(offer.offeredAmount).toBe(66.67);
  });

  it("reports every problem at once", () => {
    const offer = buildRevisedOffer({
      itemsTotal: 900,
      deductions: [damage({ reason: "" }), damage({ findingKey: "powers_on" })],
      checklist,
    });

    expect(offer.errors.length).toBe(2);
  });
});

describe("the five-day window", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("expires five days out", () => {
    expect(OFFER_RESPONSE_DAYS).toBe(5);
    expect(offerExpiryFrom(now)).toEqual(new Date("2026-09-15T12:00:00Z"));
  });

  it("is not expired while the window is open", () => {
    const request = { refundBreakdown: { offerExpiresAt: new Date("2026-09-15T12:00:00Z") } };

    expect(offerHasExpired(request, now)).toBe(false);
  });

  it("is expired once it has passed", () => {
    const request = { refundBreakdown: { offerExpiresAt: new Date("2026-09-09T12:00:00Z") } };

    expect(offerHasExpired(request, now)).toBe(true);
  });

  it("treats a request with no offer as not expired", () => {
    // Nothing was offered, so nothing can lapse.
    expect(offerHasExpired({}, now)).toBe(false);
    expect(offerHasExpired({ refundBreakdown: {} }, now)).toBe(false);
  });
});

describe("access tokens", () => {
  it("makes a long, URL-safe token", () => {
    const token = createAccessToken();

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never makes the same one twice", () => {
    const tokens = new Set(Array.from({ length: 200 }, createAccessToken));

    expect(tokens.size).toBe(200);
  });

  it("matches a token against the hash of itself", () => {
    const token = createAccessToken();

    expect(tokenMatchesHash(token, hashToken(token))).toBe(true);
  });

  it("does not match a token against itself in plaintext", () => {
    // The failure this rename exists to prevent. If a record still held a
    // plaintext token, comparing against it must fail rather than quietly
    // work — otherwise the migration looks finished when it is not.
    const token = createAccessToken();

    expect(tokenMatchesHash(token, token)).toBe(false);
  });

  it("stores something that cannot be put in a URL", () => {
    const token = createAccessToken();
    const stored = hashToken(token);

    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
    // A stolen database gives an attacker this, and this is not a link.
    expect(stored).not.toContain(token);
  });

  it("hashes the same token to the same digest every time", () => {
    const token = createAccessToken();

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("rejects a different token, including one that only differs at the end", () => {
    const token = createAccessToken();

    expect(tokenMatchesHash(token, hashToken(createAccessToken()))).toBe(false);
    expect(tokenMatchesHash(`${token.slice(0, -1)}X`, hashToken(token))).toBe(false);
  });

  it("rejects a missing token rather than treating it as a match", () => {
    const token = createAccessToken();

    for (const candidate of [null, undefined, ""]) {
      expect(tokenMatchesHash(candidate, hashToken(token))).toBe(false);
      expect(tokenMatchesHash(token, candidate)).toBe(false);
    }
  });

  it("rejects a shorter or longer candidate without throwing", () => {
    const token = createAccessToken();

    expect(tokenMatchesHash("short", token)).toBe(false);
    expect(tokenMatchesHash(`${token}extra`, token)).toBe(false);
  });
});
