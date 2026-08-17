const { GoogleGenAI, createUserContent, createModelContent } = require("@google/genai");

// SEG F-09: an explicit, pinned model ID — never a floating "*-latest" alias,
// which lets Google change this chatbot's behavior (tone, verbosity,
// instruction-following, and eventually rejected request parameters) with no
// deploy and no signal on our side.
//
// The default below is verified against this project's key on 2026-08-14 by
// timing three real support questions per candidate:
//   gemini-3.5-flash-lite  ~1.0s, consistent, no reasoning tokens  ← chosen
//   gemini-3.5-flash       8–24s, one outright failure, ~300–400 reasoning tokens
//   gemini-3.7-flash       503 on realistic prompts
//   gemini-2.5-flash       404 on this account
// The lite model is the right tool here precisely because this assistant does
// no reasoning: every fact it may state arrives in the request as a curated
// knowledge block (services/chat/siteKnowledge.js), so the work is phrasing,
// not thinking — and a support widget that answers in one second instead of
// fifteen is a different product. Override per environment with GEMINI_MODEL,
// and re-time it the same way before moving it.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MODEL = process.env.GEMINI_MODEL || DEFAULT_MODEL;

// A pinned ID is the whole point of F-09, so an alias sneaking back in via
// config should be loud rather than silent.
if (/-latest$/.test(MODEL)) {
  console.warn(
    JSON.stringify({
      event: "chat_config_warning",
      detail: "GEMINI_MODEL is a floating alias; pin an explicit model ID (SEG F-09)",
      model: MODEL,
    })
  );
}

const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 12000;
const MAX_RETRIES_ON_TRANSIENT_ERROR = 1;

// SEG §06 "cap output": every ceiling in that section is multiplied by how many
// tokens one request can spend, and the system prompt already asks for 1–3
// sentences. 1024 leaves room for the model's internal reasoning tokens (which
// count against this budget on 3.x) without letting a single reply run away.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 1024;

// SEG F-10: explicit safety settings instead of Google's defaults — "you are
// responsible for determining the necessary and appropriate safety settings
// ... for your use case." BLOCK_MEDIUM_AND_ABOVE across all four categories
// is a reasonable retail-support default; revisit once real conversation
// logs show it's too strict or too loose.
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
];

const SAFETY_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

// SEG F-14: constructed once at module load, not on every request.
let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

// history: [{ role: 'user' | 'assistant', content: string }], oldest first
function toGeminiContents(history) {
  return history.map((turn) => (
    turn.role === "assistant"
      ? createModelContent(turn.content)
      : createUserContent(turn.content)
  ));
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Gemini request timed out after ${ms}ms`);
      error.transient = true;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isTransientError(error) {
  const status = error?.status || error?.response?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || error?.transient === true;
}

async function callModel({ systemPrompt, history }) {
  const ai = getClient();
  return ai.models.generateContent({
    model: MODEL,
    contents: toGeminiContents(history),
    config: {
      systemInstruction: systemPrompt,
      safetySettings: SAFETY_SETTINGS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
}

// SEG F-13: bounded latency plus a single retry on a transient failure —
// never retries a 400 (malformed request), which would just fail again.
async function complete({ systemPrompt, history }) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES_ON_TRANSIENT_ERROR; attempt += 1) {
    try {
      const response = await withTimeout(callModel({ systemPrompt, history }), REQUEST_TIMEOUT_MS);

      // SEG F-10: a safety-blocked response has empty text — surface it as
      // a distinct, expected case instead of an empty bubble.
      const finishReason = response.candidates?.[0]?.finishReason || null;
      const blockedBySafety = SAFETY_FINISH_REASONS.has(finishReason);

      return {
        text: blockedBySafety ? null : response.text,
        blockedBySafety,
        finishReason,
        // SEG §11 requires logging the exact model ID that answered, not the
        // one we think is configured.
        model: MODEL,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === MAX_RETRIES_ON_TRANSIENT_ERROR) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // The Gemini SDK's own error carries a `status` (e.g. 401 from Google's
  // API) that has nothing to do with whether the customer is logged in to
  // our site — left unwrapped, the global error handler forwards that
  // status to the client, and the frontend's axios interceptor then
  // misreads a broken Gemini key as "this user needs to sign in" and
  // redirects to the login page. Re-throw as a clean upstream failure
  // instead so it's handled (and alerted on) as the real 5xx it is.
  const upstreamError = new Error(`Gemini request failed: ${lastError.message}`);
  upstreamError.status = 502;
  throw upstreamError;
}

module.exports = { complete };
