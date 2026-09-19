// Matching a product to the best photo we hold for it.
//
// This is the matcher that used to live in Frontend/src/utilities/productImages.js
// and run in every visitor's browser, on every product, on every render. It was
// removed from there on 19 September 2026 and moved here, because the job it
// does belongs to a migration and not to a render:
//
//   - it guesses, and a guess needs reviewing before it reaches a customer.
//     Running it once with a dry run means somebody reads the answer first.
//   - it needs a manifest of 891 records, which was 316 KB shipped to every
//     visitor for a decision that never changes between page loads.
//   - it only ever ran where `imageIsGeneric` was set, which no production
//     product carries — so the live site and a developer's laptop showed
//     different photos for the same device.
//
// The logic is unchanged, including every fix made to it while it was in the
// frontend. Those fixes are load-bearing and each one is explained where it
// sits. Do not "simplify" them without reading why they exist.

const normalizeText = (value = "") => (
  String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
);

const tokenize = (value = "") => normalizeText(value).split(" ").filter(Boolean);
const unique = (items) => Array.from(new Set(items));

const PRODUCT_STOP_WORDS = new Set([
  "apple", "cellular", "wifi", "wi", "fi", "gb", "tb", "gen", "generation", "inch",
]);

const COLOR_STOP_WORDS = new Set([
  "product", "titanium", "space", "sierra", "alpine", "sky",
]);

const FAMILY_SEGMENT = { iphone: "iphone", ipad: "ipad", macbook: "macbook" };

const ORDINAL_SUFFIXES = { 1: "st", 2: "nd", 3: "rd" };
const ordinalSuffixFor = (n) => (
  (n % 100 >= 11 && n % 100 <= 13) ? "th" : (ORDINAL_SUFFIXES[n % 10] || "th")
);

// A manifest folder can name a *range* of generations it covers with one set of
// photos (e.g. "iPad 7-9th Gen" — the 7th, 8th and 9th look identical).
// Tokenizing only keeps the two numbers actually written ("7" and "9th"), so an
// 8th-gen product had nothing to match — and even 7th-gen didn't, since a
// product asks for the token "7th", never bare "7". Expand the range into every
// ordinal token it covers.
const expandGenerationRangeTokens = (originalPath) => {
  const match = originalPath.match(/(\d+)\s*-\s*(\d+)(st|nd|rd|th)/i);
  if (!match) return [];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 10) return [];
  const tokens = [];
  for (let n = start; n <= end; n += 1) tokens.push(`${n}${ordinalSuffixFor(n)}`);
  return tokens;
};

// iPhone 16e's photos live under ".../iPhone/16/e/...", i.e. the model number
// and the "e" suffix are separate folder levels — so the path tokenizes to "16"
// and "e" separately, never the single "16e" token a product named "iPhone 16e"
// requires. Recombine an adjacent number+"e" pair into that one token.
const expandESuffixToken = (pathParts) => {
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    if (/^\d+$/.test(pathParts[i]) && pathParts[i + 1] === "e") {
      return [`${pathParts[i]}e`];
    }
  }
  return [];
};

const buildRecords = (manifest) => manifest.map((image) => {
  const searchable = normalizeText(`${image.category} ${image.model} ${image.file} ${image.originalPath}`);
  const pathParts = image.originalPath.split("/").map((part) => normalizeText(part));
  const extraTokens = [
    ...expandGenerationRangeTokens(image.originalPath),
    ...expandESuffixToken(pathParts),
  ];
  return {
    ...image,
    searchable,
    pathParts,
    tokens: new Set([...tokenize(searchable), ...extraTokens]),
  };
});

const getFamily = (product) => {
  const value = normalizeText(`${product?.categoryName || ""} ${product?.productName || ""}`);
  if (value.includes("iphone")) return "iphone";
  if (value.includes("ipad")) return "ipad";
  if (value.includes("macbook")) return "macbook";
  return "";
};

const getProductTokens = (product) => unique(
  tokenize(`${product?.categoryName || ""} ${product?.productName || ""}`)
    .filter((token) => !PRODUCT_STOP_WORDS.has(token))
);

const getColorTokens = (product) => unique(
  tokenize(product?.color?.name || "").filter((token) => !COLOR_STOP_WORDS.has(token))
);

const getRequiredModelTokens = (product, family) => {
  const nameTokens = tokenize(product?.productName || "");
  const categoryTokens = tokenize(product?.categoryName || "");
  const required = [];

  nameTokens.forEach((token, index) => {
    if (/^\d+(st|nd|rd|th)$/.test(token)) required.push(token);
    if (/^\d+e$/.test(token)) required.push(token);
    if (/^m\d+$/.test(token)) required.push(token);

    if (family === "iphone") {
      if (/^\d+$/.test(token) && nameTokens[index - 1] === "iphone") required.push(token);
      if (["mini", "plus", "pro", "max"].includes(token)) required.push(token);
    }

    // Screen size is not required: the manifest already groups sizes that look
    // identical under one folder (e.g. "M1 Pro 13+14"), and the Max-chip folders
    // carry no size token at all. Requiring an exact digit match left every 16"
    // Pro/Max variant with nothing to match and no fallback photo.
    if (family === "macbook" && ["air", "pro", "max"].includes(token)) required.push(token);

    if (family === "ipad") {
      if (/^\d+$/.test(token) && ["11", "13"].includes(token)) required.push(token);
      if (["mini", "air", "pro"].includes(token)) required.push(token);
    }
  });

  if (family === "iphone") {
    categoryTokens.filter((t) => ["plus", "pro", "max"].includes(t)).forEach((t) => required.push(t));
  }
  if (family === "macbook") {
    categoryTokens.filter((t) => ["air", "pro"].includes(t)).forEach((t) => required.push(t));
  }
  if (family === "ipad") {
    categoryTokens.filter((t) => ["mini", "air", "pro"].includes(t)).forEach((t) => required.push(t));
  }

  return unique(required);
};

const hasRequiredFamilyPath = (image, family) => {
  const segment = FAMILY_SEGMENT[family];
  if (!segment) return true;
  if (image.pathParts[0] !== segment) return false;
  // The source zip duplicated iPad folders under MacBook; never use those for a
  // MacBook even if a chip or colour token happens to match.
  if (family === "macbook" && image.pathParts.some((part) => part === "ipad")) return false;
  return true;
};

const getForbiddenModelTokens = (family, requiredTokens) => {
  const required = new Set(requiredTokens);
  if (family === "iphone") return ["mini", "plus", "pro", "max"].filter((t) => !required.has(t));
  if (family === "ipad") return ["mini", "air", "pro"].filter((t) => !required.has(t));
  // 'max' is deliberately never forbidden for a MacBook: the Pro chassis is
  // identical whether the chip is the Pro or the Max, and the manifest
  // photographs them together (folders like "M2 Pro Max"). Only air vs pro
  // distinguishes an actually different chassis.
  if (family === "macbook") return ["air", "pro"].filter((t) => !required.has(t));
  return [];
};

const scoreImage = (image, productTokens, colorTokens, family) => {
  let score = 0;
  if (family && image.tokens.has(family)) score += 40;
  productTokens.forEach((token) => {
    if (image.tokens.has(token)) score += token.length <= 2 ? 16 : 10;
  });
  colorTokens.forEach((token) => {
    if (image.tokens.has(token)) score += 45;
  });
  if (image.searchable.includes("front")) score += 4;
  if (image.searchable.includes("hero")) score += 4;
  return score;
};

// Below this, the best candidate is not good enough to use. A product called
// "test one" in black once scored 45 on colour alone and was shown a photo of
// an iPad, which is what the threshold is here to stop.
const MIN_SCORE = 35;

/**
 * The best photo for one product.
 *
 * @returns {{publicId, score, matchedOn, originalPath} | null} — null when
 *   nothing scored well enough, which is a product to leave alone rather than
 *   guess at.
 */
function matchProductPhoto(product, records) {
  const productTokens = getProductTokens(product);
  if (!productTokens.length) return null;

  const family = getFamily(product);
  const colorTokens = getColorTokens(product);
  const requiredModelTokens = getRequiredModelTokens(product, family);
  const forbiddenModelTokens = getForbiddenModelTokens(family, requiredModelTokens);

  const matching = (colors) => records.filter((image) => (
    hasRequiredFamilyPath(image, family)
    && requiredModelTokens.every((t) => image.tokens.has(t))
    && forbiddenModelTokens.every((t) => !image.tokens.has(t))
    && (colors.length === 0 || colors.every((t) => image.tokens.has(t)))
  ));

  // Colour is a hard filter first, because a colour-specific photo is always the
  // right answer when one exists. But not every model is photographed per
  // colour: the iPhone 17 Pro files are named iphone-17-pro-1/2/3 with no colour
  // in them, so requiring a colour token eliminated every candidate and sent the
  // whole model to no match at all. Retrying without the colour constraint gives
  // those products a real photo of the right model. Colour matches still win
  // outright wherever they exist — this only runs when nothing matched.
  let candidates = matching(colorTokens);
  let scoringColorTokens = colorTokens;
  let matchedOn = "model+colour";

  if (!candidates.length && colorTokens.length) {
    candidates = matching([]);
    scoringColorTokens = [];
    matchedOn = "model only";
  }
  if (!candidates.length) return null;

  const best = candidates.reduce((winner, image) => {
    const score = scoreImage(image, productTokens, scoringColorTokens, family);
    if (!winner || score > winner.score) return { image, score };
    return winner;
  }, null);

  if (!best || best.score < MIN_SCORE) return null;

  return {
    publicId: best.image.publicId,
    score: best.score,
    matchedOn,
    originalPath: best.image.originalPath,
  };
}

module.exports = { buildRecords, matchProductPhoto, MIN_SCORE };
