const ChatSettings = require("../../models/chatSettings.model");
const ChatDailyUsage = require("../../models/chatDailyUsage.model");
const { notifyBudgetUsage, notifyKillSwitch } = require("./chatAlerts");

const SETTINGS_KEY = "global";
const DEFAULT_DAILY_REQUEST_BUDGET = Number(process.env.CHAT_DAILY_REQUEST_BUDGET) || 500;

// Reading the settings used to be an upsert — a *write* to Mongo on every
// single customer message, to fetch one boolean that changes maybe twice a
// year. Now it is a plain read, cached briefly.
//
// The cache window is the kill switch's reaction time, so it is deliberately
// short: flip the switch and the widget stops within this many seconds, which
// is fast enough for an emergency control and still removes almost every
// settings query under real traffic. setKillSwitch clears the cache itself, so
// the admin who flips it sees the effect immediately.
const SETTINGS_CACHE_MS = Number(process.env.CHAT_SETTINGS_CACHE_MS) || 15000;
const DEFAULT_SETTINGS = { killSwitchEnabled: false };

let settingsCache = { expiresAt: 0, value: null };

async function getChatSettings() {
  const now = Date.now();
  if (settingsCache.value && settingsCache.expiresAt > now) return settingsCache.value;

  try {
    // No upsert: the row is created by setKillSwitch when an admin first uses
    // it, and until then the defaults are correct anyway.
    const settings = (await ChatSettings.findOne({ key: SETTINGS_KEY }).lean()) || DEFAULT_SETTINGS;
    settingsCache = { value: settings, expiresAt: now + SETTINGS_CACHE_MS };
    return settings;
  } catch (error) {
    // A database blip must not take the chat down, and must not silently
    // enable a switch someone deliberately turned on — serve the last known
    // value if there is one, and fail open only when there has never been one.
    console.error("Chat settings lookup failed:", error.message);
    return settingsCache.value || DEFAULT_SETTINGS;
  }
}

async function setKillSwitch(enabled, actor) {
  const settings = await ChatSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { killSwitchEnabled: enabled } },
    { upsert: true, new: true }
  );
  // The person flipping it should not have to wait out the cache.
  settingsCache = { value: settings, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  notifyKillSwitch({ enabled, actor });
  return settings;
}

function resetSettingsCache() {
  settingsCache = { expiresAt: 0, value: null };
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

  // SEG §11: alert on the request that crosses 50% / 80% / 100%, so the budget
  // is something someone hears about before it runs out rather than after.
  notifyBudgetUsage({
    previousCount: usage.requestCount - 1,
    currentCount: usage.requestCount,
    budget: DEFAULT_DAILY_REQUEST_BUDGET,
  });

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
  resetSettingsCache,
  SETTINGS_CACHE_MS,
  claimDailyRequestBudget,
  recordTokenUsage,
  DEFAULT_DAILY_REQUEST_BUDGET,
};
