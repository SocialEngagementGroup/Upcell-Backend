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
const DISCOUNT_CODE_PATTERN = /\b[A-Z0-9]{4,12}(?:OFF|SAVE|DEAL|PROMO)\b/;
const PROMPT_LEAK_MARKERS = [
  "you are the customer support assistant for upcell",
  "never guess or invent",
];
const SAFE_FALLBACK_REPLY =
  "I can't confirm specific pricing or discounts here — let me connect you with our support team for that.";

function screenModelReply(text) {
  if (!text) return { text, blocked: false };

  const lower = text.toLowerCase();
  const leaksPrompt = PROMPT_LEAK_MARKERS.some((marker) => lower.includes(marker));
  const inventsDiscount = DISCOUNT_CODE_PATTERN.test(text);

  if (leaksPrompt || inventsDiscount) {
    return { text: SAFE_FALLBACK_REPLY, blocked: true };
  }

  return { text, blocked: false };
}

// SEG F-07: escalate on real conditions instead of a hardcoded false.
const DISTRESS_KEYWORDS = ["kill myself", "suicide", "self harm", "self-harm", "want to die"];
const ESCALATION_KEYWORDS = [
  "talk to a human", "talk to a person", "speak to a human", "speak to a person",
  "real person", "human agent", "customer service rep",
  "refund", "chargeback", "lawsuit", "lawyer", "legal action", "sue you",
  "another customer", "someone else's order", "someone else's account",
];

function shouldEscalate({ userMessage, modelReplyBlocked, consecutiveUnansweredTurns }) {
  const lower = (userMessage || "").toLowerCase();

  if (DISTRESS_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { escalate: true, reason: "distress" };
  }
  if (ESCALATION_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { escalate: true, reason: "keyword" };
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
