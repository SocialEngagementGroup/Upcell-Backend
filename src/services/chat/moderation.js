// SEG F-06: redact sensitive data before it's ever written to the
// transcript (and therefore before it ever reaches Gemini as history).
// Heuristic pattern matching, not a certified PCI redaction tool — expand
// these patterns as real conversations surface gaps (see Task #15 test pass).
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const CVV_PATTERN = /\bcvv\D{0,5}\d{3,4}\b/gi;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

function isPlausibleCardNumber(match) {
  const digits = match.replace(/[ -]/g, "");
  return digits.length >= 13 && digits.length <= 19;
}

function redactSensitiveInput(text) {
  if (!text) return { text, redacted: false };

  let redacted = false;
  let clean = text.replace(CARD_NUMBER_PATTERN, (match) => {
    if (!isPlausibleCardNumber(match)) return match;
    redacted = true;
    return "[redacted-card-number]";
  });
  clean = clean.replace(CVV_PATTERN, () => {
    redacted = true;
    return "[redacted-cvv]";
  });
  clean = clean.replace(SSN_PATTERN, () => {
    redacted = true;
    return "[redacted-id-number]";
  });

  return { text: clean, redacted };
}

// SEG F-05: screen the model's reply before it's ever shown to the customer
// or written to the transcript. Two things must never leave this function
// unchanged — an invented discount/promo code, and a leaked fragment of the
// system prompt. Prompting ("never guess or invent") is a mitigation, not a
// control (SEG Section 07) — this is the actual control.
const { SYSTEM_PROMPT } = require("./systemPrompt");

const DISCOUNT_CODE_PATTERN = /\b[A-Z0-9]{4,12}(?:OFF|SAVE|DEAL|PROMO)\b/;

// A specific price or payout figure is the most expensive thing this bot can
// say — Moffatt v. Air Canada (SEG §07) is precisely a customer holding an
// operator to a number its chatbot invented. Prices are therefore checked
// against the live catalogue rather than banned outright; see screenModelReply.
const PERCENT_DISCOUNT_PATTERN = /\b\d{1,3}\s?%\s*(?:off|discount|back)\b/i;

// The return window is a commitment, so the number is verified rather than
// trusted: 30 days is what both the Return Policy page and Terms & Conditions
// §6 now say (the client settled the 30-vs-14 conflict on 14 Aug 2026), and a
// reply claiming any other window is blocked. Bounded by [^.] so it can't reach
// across a sentence into an unrelated figure like "3–7 business days".
const RETURN_WINDOW_DAYS = 30;
const RETURN_WINDOW_PATTERNS = [
  /\b(\d{1,3})\s*(?:calendar\s+|business\s+)?days?\b[^.]{0,40}\b(?:return|refund|exchange)/gi,
  /\b(?:return|refund|exchange)\w*\b[^.]{0,40}\b(\d{1,3})\s*(?:calendar\s+|business\s+)?days?\b/gi,
];

function statesWrongReturnWindow(text) {
  for (const pattern of RETURN_WINDOW_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (Number(match[1]) !== RETURN_WINDOW_DAYS) return true;
    }
  }
  return false;
}

// SEG F-05: the previous two hardcoded marker strings only caught a verbatim
// leak of the prompt's opening lines — a paraphrase, or a leak of any other
// part of it, passed straight through. Deriving the markers from the prompt
// itself means the screen keeps matching whatever the prompt currently says,
// with no second copy to maintain.
const LEAK_SHINGLE_LENGTH = 7;

function buildLeakShingles(prompt) {
  const words = prompt.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const shingles = new Set();
  for (let i = 0; i + LEAK_SHINGLE_LENGTH <= words.length; i += 1) {
    shingles.add(words.slice(i, i + LEAK_SHINGLE_LENGTH).join(" "));
  }
  return shingles;
}

const PROMPT_LEAK_SHINGLES = buildLeakShingles(SYSTEM_PROMPT);

function leaksSystemPrompt(text) {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  for (let i = 0; i + LEAK_SHINGLE_LENGTH <= words.length; i += 1) {
    if (PROMPT_LEAK_SHINGLES.has(words.slice(i, i + LEAK_SHINGLE_LENGTH).join(" "))) {
      return true;
    }
  }
  return false;
}

const SAFE_FALLBACK_REPLY =
  "I can't confirm specific pricing or discounts here — let me connect you with our support team for that.";

// Every money figure in a reply, as integers. Two shapes: a number carrying a
// currency marker, and a bare number sitting next to a price word — the second
// is what catches "দাম ৭৪৯" and "the price is 749", where nothing marks the
// figure as money at all. Sizes and percentages are excluded so "128GB" and
// "13-inch" are never read as prices.
const NOT_A_PRICE = "(?!\\s*(?:gb|tb|inch|%|percent|mm|hz|day|days|week|weeks|month|months|hour|hours|year|years|business))";
const CURRENCY_MONEY_PATTERN = new RegExp(
  `(?:\\$|US\\$|USD\\s*)\\s?(\\d[\\d,]*)(?:\\.\\d{1,2})?${NOT_A_PRICE}` +
  `|\\b(\\d[\\d,]*)(?:\\.\\d{1,2})?\\s*(?:dollars|usd|ডলার)\\b`,
  "gi"
);
// Three digits minimum, deliberately: the cheapest thing UpCell lists is $119,
// so a one- or two-digit number beside a price word is a delivery window, not
// money. Without this, "Priority shipping costs extra and takes 2–3 business
// days" read the "2" as a price, failed the catalogue check, and replaced a
// correct answer to one of the most common questions with a refusal. Anything
// genuinely small and monetary still carries a currency marker and is caught by
// the pattern above.
const PRICE_CONTEXT_PATTERN = new RegExp(
  `(?:price|priced|prices|cost|costs|starts at|going for|দাম|মূল্য)[^.\\n]{0,25}?\\b(\\d{3}[\\d,]*)(?:\\.\\d{1,2})?${NOT_A_PRICE}`,
  "gi"
);

// The assistant answers in the customer's language, and a model writing Bengali
// will write Bengali digits — "৭৯৯ ডলার". Those have to be folded to ASCII
// before any figure is checked, or a hallucinated price slips past the screen
// simply by being written in another script.
const DIGIT_RANGES = [
  [0x0966, "०"], // Devanagari
  [0x09e6, "০"], // Bengali
  [0x0660, "٠"], // Arabic-Indic
  [0x06f0, "۰"], // Extended Arabic-Indic
];

function normaliseDigits(text) {
  return text.replace(/[०-९০-৯٠-٩۰-۹]/g, (char) => {
    const code = char.codePointAt(0);
    for (const [base] of DIGIT_RANGES) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return char;
  });
}

function statedPrices(text) {
  const normalised = normaliseDigits(text);
  const found = [];
  for (const pattern of [CURRENCY_MONEY_PATTERN, PRICE_CONTEXT_PATTERN]) {
    for (const match of normalised.matchAll(pattern)) {
      const raw = match[1] || match[2];
      if (raw) found.push(Number(raw.replace(/,/g, "")));
    }
  }
  return found;
}

// `allowedPrices` is the set of prices the live catalogue actually contains
// (catalogueService.js). When it is supplied, a reply may quote a real listed
// price but an invented one is still blocked — which is the difference between
// grounding and guessing, and the only reason stating a price is acceptable at
// all after Moffatt v. Air Canada (SEG §07). Without it, no price may be stated.
function screenModelReply(text, { allowedPrices = null, userMessage = "" } = {}) {
  if (!text) return { text, blocked: false };

  const reasons = [];
  if (leaksSystemPrompt(text)) reasons.push("prompt_leak");
  if (DISCOUNT_CODE_PATTERN.test(text)) reasons.push("discount_code");

  const prices = statedPrices(text);
  if (prices.length > 0) {
    // A figure the customer themselves just wrote ("I have $900") is not a
    // claim when the assistant repeats it back, so it doesn't need to exist in
    // the catalogue — otherwise every budget question gets blocked.
    const echoed = new Set(statedPrices(userMessage));
    const unverifiable = prices.filter((price) => (
      !echoed.has(price) && !(allowedPrices && allowedPrices.has(price))
    ));
    if (unverifiable.length > 0) reasons.push("price_claim");
  }
  if (PERCENT_DISCOUNT_PATTERN.test(text)) reasons.push("percent_discount");
  if (statesWrongReturnWindow(normaliseDigits(text))) reasons.push("return_window_claim");

  if (reasons.length > 0) {
    return { text: SAFE_FALLBACK_REPLY, blocked: true, reasons };
  }

  return { text, blocked: false, reasons: [] };
}

// SEG F-07: escalate on real conditions instead of a hardcoded false.
const DISTRESS_KEYWORDS = ["kill myself", "suicide", "self harm", "self-harm", "want to die"];
const ESCALATION_KEYWORDS = [
  "talk to a human", "talk to a person", "speak to a human", "speak to a person",
  "real person", "human agent", "customer service rep",
  "refund", "chargeback", "lawsuit", "lawyer", "legal action", "sue you",
  "another customer", "someone else's order", "someone else's account",
];

// SEG §09 "anything that changes state": the model has no write access and
// must not imply it does, so these route to a human instead of being answered.
const STATE_CHANGE_KEYWORDS = [
  "cancel my order", "cancel the order", "change my address", "change the address",
  "update my address", "edit my order", "change my order", "cancel my trade-in",
];

// SEG §09 "abusive or harassing language": end the exchange through a human
// rather than trying to de-escalate through the model.
const ABUSE_KEYWORDS = ["fuck", "fucking", "bitch", "asshole", "bastard", "shut up you"];

function matches(list, lower) {
  return list.some((kw) => lower.includes(kw));
}

function shouldEscalate({
  userMessage,
  modelReplyBlocked,
  consecutiveUnansweredTurns,
  inputRedacted = false,
  blockedTopic = null,
}) {
  const lower = (userMessage || "").toLowerCase();

  // Ordered by how badly a wrong answer would land, most severe first.
  if (matches(DISTRESS_KEYWORDS, lower)) {
    return { escalate: true, reason: "distress" };
  }
  // SEG §05/§09: card or ID data was volunteered and redacted on write — never
  // continue the flow as if it were a normal question.
  if (inputRedacted) {
    return { escalate: true, reason: "sensitive_data_volunteered" };
  }
  if (matches(ABUSE_KEYWORDS, lower)) {
    return { escalate: true, reason: "abuse" };
  }
  if (matches(STATE_CHANGE_KEYWORDS, lower)) {
    return { escalate: true, reason: "state_change_request" };
  }
  if (matches(ESCALATION_KEYWORDS, lower)) {
    return { escalate: true, reason: "keyword" };
  }
  // A topic where two site pages disagree, so the answer must carry a human
  // route as well (SEG §07). None open at the moment.
  if (blockedTopic) {
    return { escalate: true, reason: `unapproved_topic:${blockedTopic}` };
  }
  if (modelReplyBlocked) {
    return { escalate: true, reason: "output_blocked" };
  }
  if (consecutiveUnansweredTurns >= 2) {
    return { escalate: true, reason: "repeated_no_match" };
  }
  return { escalate: false, reason: null };
}

module.exports = { redactSensitiveInput, screenModelReply, shouldEscalate };
