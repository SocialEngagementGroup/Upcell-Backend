// What sales tax UpCell charges, in one place.
//
// The rate was a constant sitting in the middle of the checkout controller and
// three hardcoded 0.08s in the frontend. Four copies of one number, and the
// only way to change it was to find all four.
//
// It is flat: 8% on goods, every US state, and pickup. UpCell is in Columbus
// (Franklin County), where the rate rose to 8% when the COTA transit levy took
// effect on 1 April 2025. Charging the same everywhere is a simplification
// UpCell has chosen deliberately rather than an oversight — the accountant
// sign-off on it is tracked as X10 in PIPELINE.md.
//
// Shipping is never taxed.

// Read per call rather than at import, so the value is whatever dotenv has
// loaded by the time a request arrives — not whatever was set when this module
// happened to be required first. The same reason auth.middleware reads the
// Clerk key per call.
function salesTaxRate() {
  const raw = process.env.SALES_TAX_RATE;

  // Checked as a string first, because Number("") is 0, not NaN. A .env line
  // reading SALES_TAX_RATE= with nothing after it would otherwise pass every
  // test below and set the rate to zero — which is the fat-fingered deploy the
  // fallback exists to survive, not one it should wave through.
  if (typeof raw !== "string" || raw.trim() === "") return 0.08;

  const configured = Number(raw);

  // A missing or unreadable env var falls back to the rate that has always
  // been charged. A tax rate of 0 because somebody fat-fingered a deploy is
  // not a failure anyone would notice until an accountant did.
  if (!Number.isFinite(configured) || configured < 0 || configured > 1) {
    return 0.08;
  }

  return configured;
}

/**
 * Tax on an order's goods.
 *
 * @param {object} args
 * @param {number} args.goodsCents - the devices and accessories, never shipping
 * @param {string} [args.shipToState] - two-letter US state, or undefined for pickup
 * @returns {{ taxCents: number, rate: number }}
 *
 * `shipToState` is accepted and deliberately unused. It is the seam: the day
 * UpCell registers in a second state, the rule changes here and no call site
 * moves. A signature that has to grow later is a signature every caller has to
 * be found and edited for.
 */
function calculateTax({ goodsCents, shipToState } = {}) {
  const rate = salesTaxRate();
  const goods = Number(goodsCents);

  if (!Number.isFinite(goods) || goods <= 0) {
    return { taxCents: 0, rate };
  }

  return { taxCents: Math.round(goods * rate), rate };
}

module.exports = { calculateTax, salesTaxRate };
