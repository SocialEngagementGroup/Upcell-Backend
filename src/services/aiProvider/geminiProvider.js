const { GoogleGenAI, createUserContent, createModelContent } = require("@google/genai");

// Flash tier: covered by the free tier and matches the "fast/cheap" model
// this bot's traffic actually needs (see Upcell-Chatbot-Plan.md). Using the
// "-latest" alias rather than a pinned version like "gemini-2.5-flash" —
// that exact model returned 404 "no longer available to new users" on this
// account, and pinning again would just repeat the same failure whenever
// Google retires the next version.
const MODEL = "gemini-flash-latest";

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  return new GoogleGenAI({ apiKey });
}

// history: [{ role: 'user' | 'assistant', content: string }], oldest first
function toGeminiContents(history) {
  return history.map((turn) => (
    turn.role === "assistant"
      ? createModelContent(turn.content)
      : createUserContent(turn.content)
  ));
}

async function complete({ systemPrompt, history }) {
  const ai = getClient();

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: toGeminiContents(history),
      config: {
        systemInstruction: systemPrompt,
      },
    });

    return { text: response.text };
  } catch (error) {
    // The Gemini SDK's own error carries a `status` (e.g. 401 from Google's
    // API) that has nothing to do with whether the customer is logged in to
    // our site — left unwrapped, the global error handler forwards that
    // status to the client, and the frontend's axios interceptor then
    // misreads a broken Gemini key as "this user needs to sign in" and
    // redirects to the login page. Re-throw as a clean upstream failure
    // instead so it's handled (and alerted on) as the real 5xx it is.
    const upstreamError = new Error(`Gemini request failed: ${error.message}`);
    upstreamError.status = 502;
    throw upstreamError;
  }
}

module.exports = { complete };
