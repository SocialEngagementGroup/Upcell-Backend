const SingleVariation = require("../../models/singleVariation.model");
const { DOCUMENTED_CONDITIONS } = require("./siteKnowledge");

// The product catalogue as the chatbot sees it: an aggregated, in-stock-only,
// read-only snapshot of exactly the data the Shop page already renders to every
// visitor. Nothing here is customer data — no orders, no accounts, no quotes, no
// PII — so it can be handed to the model without changing the risk profile that
// SEG §10 warns about. The model still cannot query anything: the server builds
// this, the model only reads it.
//
// Aggregated by model rather than listing all ~950 variations: it keeps the
// prompt small, and per-variant availability is exactly the thing that goes
// stale between refreshes. Model + storage + condition + price range is stable
// enough to state, and the reply always points at /shop for the live check.

const CACHE_TTL_MS = Number(process.env.CHAT_CATALOGUE_TTL_MS) || 5 * 60 * 1000;
const ENABLED = process.env.CHAT_CATALOGUE_ENABLED !== "false";

let cache = { expiresAt: 0, snapshot: null };

function formatPrice(value) {
  return `$${Math.round(value)}`;
}

// The product page route, exactly as ModernProductCard and ShopPage build it.
function productPath(variation) {
  const parentId = variation.parentCatagory;
  return parentId ? `/iphone/${parentId}/${variation._id}` : null;
}

// A condition grade the shop sells but never explains — or explains but never
// sells — is how the assistant ends up describing stock that doesn't exist, or
// staying silent about stock that does. Both happened here: "Mint" is on 251
// listings with no published definition, and "Fair" is explained on every
// product page while nothing is graded Fair. Checking on each refresh means the
// next drift is caught by the server, in the log, instead of by a customer.
function reportConditionDrift(conditionsInData) {
  const documented = new Set(DOCUMENTED_CONDITIONS);
  const undocumented = [...conditionsInData].filter((grade) => !documented.has(grade));
  const unstocked = DOCUMENTED_CONDITIONS.filter((grade) => !conditionsInData.has(grade));

  // Only the dangerous direction is worth waking anyone for: a grade on real
  // listings that nothing explains, which is how customers end up reading a
  // word the shop never defined. A documented grade being out of stock is
  // ordinary and fixes itself, and warning about it every five minutes would
  // just teach everyone to ignore this log line. It still travels in the
  // payload when a real warning fires, because it is useful context then.
  if (undocumented.length === 0) return;

  console.warn(JSON.stringify({
    event: "chat_config_warning",
    detail: "catalogue condition grades no longer match the grades the site documents",
    gradesInCatalogueWithNoDefinition: undocumented,
    gradesDocumentedButNotStocked: unstocked,
    action: "update siteKnowledge.conditionGrades and DOCUMENTED_CONDITIONS together",
  }));
}

function summarise(variations) {
  const byModel = new Map();
  const prices = new Set();
  const conditions = new Set();

  for (const variation of variations) {
    const name = variation.productName;
    if (!name) continue;

    const entry = byModel.get(name) || {
      family: variation.categoryName || "",
      storages: new Set(),
      conditions: new Set(),
      prices: [],
      cheapest: null,
    };
    if (variation.storage) entry.storages.add(variation.storage);
    if (variation.condition) {
      entry.conditions.add(variation.condition);
      conditions.add(variation.condition);
    }
    if (typeof variation.price === "number") {
      entry.prices.push(variation.price);
      prices.add(Math.round(variation.price));
      // The cheapest listing is the one worth linking to: it is the entry point
      // a customer asking "show me the iPhone 17" actually wants.
      if (!entry.cheapest || variation.price < entry.cheapest.price) {
        entry.cheapest = { price: variation.price, path: productPath(variation) };
      }
    }
    byModel.set(name, entry);
  }

  const lines = [];
  for (const [name, entry] of byModel) {
    const sorted = entry.prices.slice().sort((a, b) => a - b);
    const range = sorted.length
      ? ` — ${formatPrice(sorted[0])}${sorted.length > 1 && sorted[0] !== sorted[sorted.length - 1] ? ` to ${formatPrice(sorted[sorted.length - 1])}` : ""}`
      : "";
    const link = entry.cheapest?.path ? ` | ${entry.cheapest.path}` : "";
    lines.push(
      `${name}: ${[...entry.storages].join(", ") || "storage varies"}` +
      ` | condition ${[...entry.conditions].join(", ") || "varies"}${range}${link}`
    );
  }

  return { lines, prices, conditions, modelCount: byModel.size };
}

// "Show me your latest" is a normal shop question and the answer is knowable:
// a Mongo ObjectId carries its creation time, so the most recently listed
// products are the highest ids. Kept to five so it stays a hint, not a catalogue.
function recentlyAdded(variations) {
  const seen = new Set();
  const newest = [];

  // One line per model: the newest five variations are usually five colours of
  // the same phone, which reads as a bug rather than a list of what is new.
  for (const variation of [...variations].sort((a, b) => String(b._id).localeCompare(String(a._id)))) {
    if (!variation._id || seen.has(variation.productName)) continue;
    seen.add(variation.productName);
    newest.push(variation);
    if (newest.length === 5) break;
  }

  if (newest.length === 0) return "";

  const lines = newest.map((variation) => (
    `${variation.productName}${variation.storage ? ` ${variation.storage}` : ""}` +
    `${typeof variation.price === "number" ? ` — ${formatPrice(variation.price)}` : ""}` +
    `${productPath(variation) ? ` | ${productPath(variation)}` : ""}`
  ));

  return `\n\nMOST RECENTLY LISTED (newest first):\n${lines.join("\n")}`;
}

async function loadSnapshot() {
  // `description` rides along on the query that already runs — no extra database
  // operation, and it is deduplicated below because all ~950 variations of a
  // model share one description. Deliberately NOT selected: originalPrice and
  // discountPrice. Those are admin-only fields that appear nowhere on the
  // storefront, and discountPrice sits *below* the selling price — an internal
  // number the assistant must never be in a position to repeat.
  const variations = await SingleVariation.find({ outOfStock: { $ne: true } })
    .select("productName categoryName storage condition price parentCatagory description")
    .lean();

  const { lines, prices, conditions, modelCount } = summarise(variations);
  reportConditionDrift(conditions);

  // One description per model, not per variation. All 83 together would be
  // ~5,000 tokens, so they are held here and only the ones a customer actually
  // asks about are added to a request (see scopeToMessage).
  const descriptions = new Map();
  for (const variation of variations) {
    const text = (variation.description || "").trim();
    if (text && variation.productName && !descriptions.has(variation.productName)) {
      descriptions.set(variation.productName, text);
    }
  }

  // Kept as parts rather than one string so scopeToMessage can filter the model
  // lines without disturbing the header or the recently-listed section.
  // The grades in stock are stated rather than assumed: it is the assistant's
  // only honest answer to "are these brand new?" — every listing carries one of
  // these, and none of them is "new".
  const header =
    "LIVE CATALOGUE — the models currently listed on the Shop page, with their storage options, " +
    "condition grades, price range and the path to the product page. Every listing carries one of " +
    `these condition grades and no other: ${[...conditions].join(", ")}. Prices and availability ` +
    "change, so always point the customer at /shop to confirm before they rely on it:";
  const recentBlock = recentlyAdded(variations);

  return {
    modelCount,
    // Every price the catalogue actually contains. moderation.js checks any
    // figure the model writes against this set, so a hallucinated price is
    // caught even though real ones are now allowed through.
    allowedPrices: prices,
    conditions,
    header,
    modelLines: lines,
    recentBlock,
    descriptions,
    block: assembleBlock(header, lines, recentBlock),
    refreshedAt: Date.now(),
  };
}

function assembleBlock(header, lines, recentBlock) {
  return `${header}\n${lines.join("\n")}${recentBlock}`;
}

// Cached because this is on the customer's critical path and the catalogue does
// not change between one message and the next. A failure here is never allowed
// to break the chat — the assistant simply falls back to "check the Shop page",
// which is what it did before this existed.
async function getCatalogueSnapshot() {
  if (!ENABLED) return null;

  const now = Date.now();
  if (cache.snapshot && cache.expiresAt > now) return cache.snapshot;

  try {
    const snapshot = await loadSnapshot();
    cache = { snapshot, expiresAt: now + CACHE_TTL_MS };
    return snapshot;
  } catch (error) {
    console.error("Chat catalogue snapshot failed:", error.message);
    // Keep serving a stale snapshot rather than losing the capability entirely.
    return cache.snapshot;
  }
}

function resetCatalogueCache() {
  cache = { expiresAt: 0, snapshot: null };
}

// Sending all 83 models on every request costs ~2,000 tokens to answer "do you
// have a MacBook Air M4?". When the customer names a family, send only that
// family's lines — cheaper, and the model has less to wade through. The price
// allowlist stays whole, because it guards figures rather than selecting them.
const FAMILY_KEYWORDS = {
  iPhone: ["iphone", "আইফোন"],
  iPad: ["ipad", "আইপ্যাড"],
  MacBook: ["macbook", "mac book", "ম্যাকবুক"],
};

// UpCell's own written description of a model — the copy on its product page.
// At most two, because a customer asking about three models at once wants a
// comparison, not three paragraphs.
const MAX_PRODUCT_NOTES = 2;

function namesIn(descriptions, text) {
  const lower = (text || "").toLowerCase();
  // Longest name first, so "iPhone 16 Pro Max" wins over "iPhone 16".
  return [...descriptions.keys()]
    .filter((name) => lower.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
}

// `recentText` is what was being discussed a moment ago. Without it, "what is
// the price and feature" — asked straight after the assistant named a specific
// MacBook — matched no model and came back as "I can't confirm features",
// which is the assistant losing the thread mid-conversation.
function productNotes(snapshot, message, recentText) {
  const descriptions = snapshot.descriptions || new Map();
  const named = namesIn(descriptions, message).length
    ? namesIn(descriptions, message)
    : namesIn(descriptions, recentText);

  const chosen = [];
  for (const name of named) {
    // Skip a shorter name already covered by a longer one already chosen.
    if (chosen.some((picked) => picked.toLowerCase().includes(name.toLowerCase()))) continue;
    chosen.push(name);
    if (chosen.length === MAX_PRODUCT_NOTES) break;
  }
  if (chosen.length === 0) return "";

  const lines = chosen.map((name) => `${name}: ${snapshot.descriptions.get(name)}`);
  return `\n\nPRODUCT NOTES (UpCell's own description of the model asked about):\n${lines.join("\n")}`;
}

// Trims the catalogue to what this specific message needs: only the device
// family mentioned, plus the written description of any model named. Sending
// all 83 models with all 83 descriptions would be ~7,000 tokens on every
// request to answer "do you have a MacBook Air M4?".
function scopeToMessage(snapshot, message, recentText = "") {
  if (!snapshot) return null;

  // Family narrowing follows the current message only: what the customer is
  // asking about now decides which part of the catalogue travels. Product
  // notes may fall back to the recent conversation (see productNotes).
  const lower = (message || "").toLowerCase();
  const families = Object.entries(FAMILY_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => lower.includes(keyword)))
    .map(([family]) => family);

  const notes = productNotes(snapshot, message, recentText);

  let modelLines = snapshot.modelLines || [];
  if (families.length > 0 && families.length < Object.keys(FAMILY_KEYWORDS).length) {
    const kept = modelLines.filter((line) => (
      families.some((family) => line.toLowerCase().startsWith(family.toLowerCase()))
    ));
    if (kept.length > 0) modelLines = kept;
  }

  if (modelLines === snapshot.modelLines && !notes) return snapshot;

  return {
    ...snapshot,
    modelLines,
    // The recently-listed section stays whole: "what's new" is a different
    // question from "which iPhones do you have", and it is only five lines.
    block: assembleBlock(snapshot.header, modelLines, (snapshot.recentBlock || "") + notes),
  };
}

module.exports = {
  getCatalogueSnapshot,
  scopeToMessage,
  reportConditionDrift,
  resetCatalogueCache,
  CACHE_TTL_MS,
  ENABLED,
};
