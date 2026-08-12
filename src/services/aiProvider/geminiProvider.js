const { GoogleGenAI, createUserContent, createModelContent } = require("@google/genai");

// SEG F-09: pinned via env instead of hardcoded, so a version bump is a
// config change, not a code deploy. Still defaults to the floating alias
// because pinning "gemini-2.5-flash" 404'd "no longer available to new
// users" on this account — confirm a currently-valid pinned model ID in the
// Cloud Console before setting GEMINI_MODEL in production. That
// verification step can't be done from code alone (Task #9).
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 12000;
const MAX_RETRIES_ON_TRANSIENT_ERROR = 1;

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
