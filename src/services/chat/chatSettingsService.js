const ChatSettings = require("../../models/chatSettings.model");
const ChatDailyUsage = require("../../models/chatDailyUsage.model");

const SETTINGS_KEY = "global";
const DEFAULT_DAILY_REQUEST_BUDGET = Number(process.env.CHAT_DAILY_REQUEST_BUDGET) || 500;

async function getChatSettings() {
  const settings = await ChatSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $setOnInsert: { key: SETTINGS_KEY } },
    { upsert: true, new: true }
  );
  return settings;
}

async function setKillSwitch(enabled) {
  return ChatSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { killSwitchEnabled: enabled } },
    { upsert: true, new: true }
  );
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Atomically claims one request against today's budget BEFORE the Gemini
// call is made (SEG §06: "a hard token or request budget checked before
// each model call... it never calls Gemini" once the ceiling is hit).
async function claimDailyRequestBudget() {
  const date = todayUtc();
  const usage = await ChatDailyUsage.findOneAndUpdate(
    { date },
    { $inc: { requestCount: 1 } },
    { upsert: true, new: true }
  );
  return { allowed: usage.requestCount <= DEFAULT_DAILY_REQUEST_BUDGET, usage };
}

// Best-effort — token accounting should never be the reason a customer's
// reply fails to send.
async function recordTokenUsage({ inputTokens = 0, outputTokens = 0 }) {
  const date = todayUtc();
  await ChatDailyUsage.findOneAndUpdate(
    { date },
    { $inc: { inputTokens, outputTokens } },
    { upsert: true }
  );
}

module.exports = {
  getChatSettings,
  setKillSwitch,
  claimDailyRequestBudget,
  recordTokenUsage,
  DEFAULT_DAILY_REQUEST_BUDGET,
};
