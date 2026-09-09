// URL slugs for products and product families.
//
// The catalogue used to be addressed by Mongo ids —
// /iphone/6a271d2b72b1c0791a38e22c/6a9d620500032b3d145a4ee4 — which tells a
// customer nothing, cannot be read aloud, and is worth nothing to a search
// engine. These build the readable half of
// /product/iphone-air/iphone-air-256gb-space-black.

// Deliberately strict: lowercase, a-z0-9 and single hyphens only. Anything else
// — an ampersand in "Black & Slate", a stray emoji, an accented character — is
// collapsed to a hyphen rather than escaped, because a URL that needs
// percent-encoding to be valid defeats the point of having a readable one.
const slugify = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * A family's slug: "iPhone Air" -> "iphone-air".
 */
const parentSlug = (modelName) => slugify(modelName);

/**
 * One variant's slug, from the three things that distinguish it on the page:
 * name, storage and colour. "iPhone Air", "256GB", "Space Black" becomes
 * "iphone-air-256gb-space-black".
 *
 * Measured against the live catalogue on 9 Sep 2026: 956 products produced 956
 * distinct slugs, and 83 families produced 83. That is not a guarantee for the
 * future though — two units of the same model, storage and colour in different
 * conditions would collide — so uniqueness is enforced by an index and
 * ensureUniqueSlug below, not assumed here.
 */
const variantSlug = ({ productName, storage, color } = {}) =>
  slugify([productName, storage, color?.name].filter(Boolean).join(" "));

/**
 * Appends -2, -3 … until the slug is free.
 *
 * `isTaken` is passed in rather than a model, so this stays testable without a
 * database and works for both collections.
 */
async function ensureUniqueSlug(base, isTaken) {
  const candidate = base || "item";
  if (!(await isTaken(candidate))) return candidate;

  // Bounded rather than a while(true): if something is wrong with isTaken, a
  // runaway loop would hang the request instead of failing it.
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!(await isTaken(next))) return next;
  }

  // 100 products with the same name, storage and colour means something is
  // wrong with the data, not with the slug.
  throw new Error(`Could not find a free slug for "${candidate}"`);
}

module.exports = { slugify, parentSlug, variantSlug, ensureUniqueSlug };
