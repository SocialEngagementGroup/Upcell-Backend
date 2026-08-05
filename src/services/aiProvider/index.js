const geminiProvider = require("./geminiProvider");

// openaiProvider gets added here in a later step, when we swap providers for
// the client-facing build (see Upcell-Chatbot-Plan.md) — this is the whole
// point of keeping every provider behind the same complete({ systemPrompt,
// history }) interface.
function getAiProvider() {
  const provider = process.env.AI_PROVIDER || "gemini";

  switch (provider) {
    case "gemini":
      return geminiProvider;
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}

module.exports = { getAiProvider };
