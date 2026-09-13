const { quote, teaser, toDollars } = require("../src/services/tradeInPricing");
const { BASE_PRICES, STORAGE, QUESTIONS, CARRIERS, deviceTypeFor } = require("../scripts/seed-trade-in-pricebook");

// The arithmetic exactly as Frontend/src/pages/TradeIn/TradeIn.jsx did it on
// 11 September 2026. Copied here so the parity tests below compare the new
// engine against the real thing rather than against a description of it.
const frontendEstimate = (selection) => {
  const base = BASE_PRICES[selection.model] || 0;
  if (!base) return null;

  let price = base;
  if (selection.storage) price *= (STORAGE[selection.storage] || 1.0);

  const answers = selection.answers || {};
  if (answers.powersOn === false) return Math.round(price * 0.15);
  if (answers.functional === false) price *= 0.55;
  if (answers.cracked === false) price *= 0.50;
  if (answers.screenCondition === "good") price *= 0.90;
  if (answers.screenCondition === "fair") price *= 0.75;
  if (answers.bodyCondition === "good") price *= 0.92;
  if (answers.bodyCondition === "fair") price *= 0.80;

  return Math.round(price);
};

const bookFor = (modelKey) => {
  const deviceType = deviceTypeFor(modelKey);
  return {
    modelKey,
    deviceType,
    active: true,
    basePriceCents: Math.round(BASE_PRICES[modelKey] * 100),
    storageMultipliers: STORAGE,
    carrierAdjustments: CARRIERS[deviceType] || {},
    priceBookVersion: 1,
  };
};

const questionsFor = (modelKey) => QUESTIONS[deviceTypeFor(modelKey)] || [];

const serverEstimate = (modelKey, storage, answers, carrier) => {
  const result = quote({
    priceBook: bookFor(modelKey),
    questions: questionsFor(modelKey),
    storage,
    carrier,
    answers,
  });
  return result.ok ? Math.round(result.estimateCents / 100) : null;
};

// The gate on the whole migration. A customer who was quoted $612 yesterday
// must be quoted $612 today — a quote that moved on the day the code shipped
// is indistinguishable from a quote that was always wrong.
describe("parity with the number the browser used to produce", () => {
  const STORAGES = Object.keys(STORAGE);
  const SCREENS = [undefined, "flawless", "good", "fair"];
  const BODIES = [undefined, "flawless", "good", "fair"];
  const BOOLS = [undefined, true, false];

  it("agrees on the plan's own example: iPhone 15 Pro, 256GB, all best answers", () => {
    const answers = {
      powersOn: true, functional: true, cracked: true,
      screenCondition: "flawless", bodyCondition: "flawless",
    };

    expect(serverEstimate("iphone15pro", "256GB", answers, "unlocked"))
      .toBe(frontendEstimate({ model: "iphone15pro", storage: "256GB", answers }));
  });

  it("agrees on every model at every storage size, with nothing answered", () => {
    for (const modelKey of Object.keys(BASE_PRICES)) {
      for (const storage of STORAGES) {
        expect([modelKey, storage, serverEstimate(modelKey, storage, {})])
          .toEqual([modelKey, storage, frontendEstimate({ model: modelKey, storage, answers: {} })]);
      }
    }
  });

  it("agrees across every combination of answers, on a model of each type", () => {
    // One model per device type, every answer combination: 3 booleans x 3 x 4
    // screens x 4 bodies x 6 storages.
    const models = ["iphone15pro", "ipadair5", "mbp14m3", "s24ultra", "pixel9pro"];
    let compared = 0;

    for (const modelKey of models) {
      for (const storage of STORAGES) {
        for (const powersOn of BOOLS) {
          for (const functional of BOOLS) {
            for (const cracked of BOOLS) {
              for (const screenCondition of SCREENS) {
                for (const bodyCondition of BODIES) {
                  // Only what this device's form actually asks. calculateEstimate
                  // applied a bodyCondition deduction to anything that carried
                  // one, including an iPad — whose form has no body question, so
                  // a real iPad never carried one. Feeding it a combination the
                  // UI cannot produce would be comparing against a branch that
                  // never ran.
                  const asked = new Set(questionsFor(modelKey).map((q) => q.id));
                  const answers = {};
                  if (powersOn !== undefined && asked.has("powersOn")) answers.powersOn = powersOn;
                  if (functional !== undefined && asked.has("functional")) answers.functional = functional;
                  if (cracked !== undefined && asked.has("cracked")) answers.cracked = cracked;
                  if (screenCondition && asked.has("screenCondition")) answers.screenCondition = screenCondition;
                  if (bodyCondition && asked.has("bodyCondition")) answers.bodyCondition = bodyCondition;

                  const mine = serverEstimate(modelKey, storage, answers);
                  const theirs = frontendEstimate({ model: modelKey, storage, answers });
                  compared += 1;

                  if (mine !== theirs) {
                    throw new Error(
                      `${modelKey} ${storage} ${JSON.stringify(answers)} — server ${mine}, browser ${theirs}`
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    // Guards the loop itself: a bug in the nesting that compared nothing would
    // otherwise pass silently.
    expect(compared).toBeGreaterThan(3000);
  });

  it("agrees that a dead device is worth 15% and nothing after it counts", () => {
    // powersOn:false returned immediately in the browser, so the answers below
    // it were never applied. Anything else here would quietly re-price every
    // broken device.
    const dead = { powersOn: false, functional: false, cracked: false, screenCondition: "fair" };

    expect(serverEstimate("iphone16promax", "1TB", dead))
      .toBe(frontendEstimate({ model: "iphone16promax", storage: "1TB", answers: dead }));
  });
});

describe("the quote itself", () => {
  const iphone = { priceBook: bookFor("iphone15pro"), questions: questionsFor("iphone15pro") };

  it("shows its working", () => {
    // A number a customer disputes in November has to be explainable from the
    // record, without rerunning anything.
    const result = quote({ ...iphone, storage: "256GB", answers: { cracked: false } });

    expect(result.breakdown[0]).toEqual({ step: "base", multiplier: 1, resultCents: 59000 });
    expect(result.breakdown.map((entry) => entry.step))
      .toEqual(["base", "storage:256GB", "cracked:no"]);
  });

  it("stops at a terminal answer and says where", () => {
    const result = quote({ ...iphone, storage: "256GB", answers: { powersOn: false, cracked: false } });

    expect(result.terminatedAt).toBe("powersOn");
    expect(result.breakdown.map((entry) => entry.step)).not.toContain("cracked:no");
  });

  it("ignores an answer nobody offered", () => {
    // The options are the server's list. An id that is not on it is a stale
    // page or somebody typing into the request, and neither should move money.
    const honest = quote({ ...iphone, storage: "128GB", answers: { screenCondition: "flawless" } });
    const invented = quote({ ...iphone, storage: "128GB", answers: { screenCondition: "perfect" } });

    expect(invented.estimateCents).toBe(honest.estimateCents);
  });

  it("ignores a question the customer skipped", () => {
    const skipped = quote({ ...iphone, storage: "128GB", answers: {} });

    expect(skipped.estimateCents).toBe(59000);
  });

  it("quotes an unknown storage size at the base price rather than refusing", () => {
    // The catalogue gains sizes faster than this table does, and refusing to
    // quote for a 4TB Mac is worse than quoting the base for one.
    const result = quote({ ...iphone, storage: "4TB", answers: {} });

    expect(result.ok).toBe(true);
    expect(result.estimateCents).toBe(59000);
  });

  it("refuses a model that is not being quoted for", () => {
    expect(quote({ priceBook: { ...bookFor("iphone15pro"), active: false } }).ok).toBe(false);
    expect(quote({ priceBook: null }).ok).toBe(false);
    expect(quote({ priceBook: { ...bookFor("iphone15pro"), basePriceCents: 0 } }).ok).toBe(false);
  });

  it("records which version of the book priced it", () => {
    // So a quote disputed in November is checked against September's prices
    // rather than today's.
    const result = quote({
      priceBook: { ...bookFor("iphone15pro"), priceBookVersion: 7 },
      questions: questionsFor("iphone15pro"),
      answers: {},
    });

    expect(result.priceBookVersion).toBe(7);
  });

  it("gives the same answer every time", () => {
    const args = { ...iphone, storage: "512GB", answers: { functional: false, bodyCondition: "good" } };

    expect(quote(args).estimateCents).toBe(quote(args).estimateCents);
  });
});

describe("carrier", () => {
  it("changes nothing today, on any model", () => {
    // The browser never used carrier in its arithmetic. The field exists so a
    // locked handset can be worth less later; it must not do so now.
    for (const modelKey of ["iphone15pro", "s24ultra", "pixel9pro"]) {
      const base = serverEstimate(modelKey, "256GB", {});

      for (const carrier of Object.keys(CARRIERS[deviceTypeFor(modelKey)] || {})) {
        expect([carrier, serverEstimate(modelKey, "256GB", {}, carrier)]).toEqual([carrier, base]);
      }
    }
  });

  it("would apply an adjustment if one were set", () => {
    // Proves the seam works, so the day somebody sets 0.9 for a locked
    // handset it takes effect without a code change.
    const result = quote({
      priceBook: { ...bookFor("iphone15pro"), carrierAdjustments: { att: 0.9 } },
      questions: [],
      carrier: "att",
      answers: {},
    });

    expect(result.estimateCents).toBe(53100);
  });
});

describe("the up-to price on the model list", () => {
  it("is the best storage with the best answers", () => {
    // "Up to" has to mean the most a device of this model could fetch, or the
    // page quotes a number no real device reaches.
    const best = teaser({ priceBook: bookFor("iphone15pro"), questions: questionsFor("iphone15pro") });

    // 2TB is the highest multiplier in the table, and every best answer is
    // 1.0. $590 x 1.65 is $973.50, quoted as $974 — a whole-dollar figure, the
    // same rounding the browser did.
    expect(best).toBe(97400);
  });

  it("is never less than a real quote for the same model", () => {
    for (const modelKey of ["iphone16promax", "ipadair5", "mbp16m3", "s25ultra", "pixel9pro"]) {
      const best = teaser({ priceBook: bookFor(modelKey), questions: questionsFor(modelKey) });

      for (const storage of Object.keys(STORAGE)) {
        const real = quote({
          priceBook: bookFor(modelKey),
          questions: questionsFor(modelKey),
          storage,
          answers: { powersOn: true, functional: true, cracked: true, screenCondition: "flawless", bodyCondition: "flawless" },
        });

        expect(real.estimateCents).toBeLessThanOrEqual(best);
      }
    }
  });

  it("is zero for a model that is not being quoted for", () => {
    expect(teaser({ priceBook: { ...bookFor("iphone15pro"), active: false } })).toBe(0);
  });
});

describe("toDollars", () => {
  it("turns cents into the figure the page and the email show", () => {
    expect(toDollars(59000)).toBe(590);
    expect(toDollars(8850)).toBe(88.5);
    expect(toDollars(0)).toBe(0);
    expect(toDollars(undefined)).toBe(0);
  });
});

// Found by the parity sweep, and kept rather than matched.
describe("an answer to a question this device was never asked", () => {
  it("does not move the price", () => {
    // calculateEstimate applied its bodyCondition deduction to anything
    // carrying one, iPad included — and the iPad form has no body question, so
    // a real iPad never carried one and the branch never ran. Posting one by
    // hand did reach it.
    //
    // The engine reads the device's own question set, so an answer to a
    // question nobody asked is ignored. Same rule as an option id that is not
    // on the list: the server decides what counts.
    const ipad = { priceBook: bookFor("ipadair5"), questions: questionsFor("ipadair5") };

    const asked = quote({ ...ipad, storage: "64GB", answers: {} });
    const invented = quote({ ...ipad, storage: "64GB", answers: { bodyCondition: "good" } });

    expect(questionsFor("ipadair5").map((q) => q.id)).not.toContain("bodyCondition");
    expect(invented.estimateCents).toBe(asked.estimateCents);
  });
});

// The hole this whole phase exists to close.
describe("the submitted estimate is not the stored one", () => {
  const modelKey = "iphone15pro";
  const answers = { powersOn: true, functional: true, cracked: true, screenCondition: "flawless", bodyCondition: "flawless" };

  it("prices the device from the book, whatever the browser claims", () => {
    // Posting estimate: 9999 put nine thousand dollars in front of staff as an
    // offer to honour, and nothing anywhere contradicted it.
    const priced = quote({
      priceBook: bookFor(modelKey), questions: questionsFor(modelKey),
      storage: "256GB", carrier: "unlocked", answers,
    });

    expect(priced.estimateCents).toBe(66100);
    expect(priced.estimateCents).not.toBe(999900);
  });

  it("produces the same number for the quote and the submit", () => {
    // They are the same call. A page that quoted one figure and stored another
    // is the same bug in a quieter form.
    const args = { priceBook: bookFor(modelKey), questions: questionsFor(modelKey), storage: "256GB", answers };

    expect(quote(args).estimateCents).toBe(quote(args).estimateCents);
  });

  it("keeps the arithmetic, so a disputed quote can be answered", () => {
    const priced = quote({
      priceBook: bookFor(modelKey), questions: questionsFor(modelKey),
      storage: "256GB", carrier: "unlocked", answers,
    });

    // Every step is named and reproducible from the record alone, without
    // rerunning today's prices over an old request.
    expect(priced.breakdown.map((entry) => entry.step))
      .toEqual(["base", "storage:256GB", "carrier:unlocked"]);
    expect(priced.priceBookVersion).toBe(1);
  });
});
