jest.mock("../src/models/chatSettings.model");
jest.mock("../src/models/chatDailyUsage.model");
jest.mock("../src/services/chat/chatAlerts");

const ChatSettings = require("../src/models/chatSettings.model");
const {
  getChatSettings,
  setKillSwitch,
  resetSettingsCache,
} = require("../src/services/chat/chatSettingsService");

// Reading this row used to be an upsert — one Mongo *write* per customer
// message to fetch a boolean that changes maybe twice a year. These tests hold
// that line, and hold the kill switch's responsiveness while they do it.

const mockFindOne = (value) => {
  ChatSettings.findOne.mockReturnValue({ lean: () => Promise.resolve(value) });
};

beforeEach(() => {
  jest.clearAllMocks();
  resetSettingsCache();
  mockFindOne({ key: "global", killSwitchEnabled: false });
});

describe("getChatSettings", () => {
  it("reads, and never writes, to answer a customer message", async () => {
    await getChatSettings();

    expect(ChatSettings.findOne).toHaveBeenCalledTimes(1);
    expect(ChatSettings.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("serves repeat messages from cache instead of hitting the database again", async () => {
    await getChatSettings();
    await getChatSettings();
    await getChatSettings();

    expect(ChatSettings.findOne).toHaveBeenCalledTimes(1);
  });

  it("works before any admin has ever touched the settings", async () => {
    mockFindOne(null);
    await expect(getChatSettings()).resolves.toMatchObject({ killSwitchEnabled: false });
  });

  it("keeps serving the last known settings when the database is unreachable", async () => {
    mockFindOne({ key: "global", killSwitchEnabled: true });
    await getChatSettings();

    ChatSettings.findOne.mockImplementation(() => { throw new Error("mongo down"); });
    jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Cache still valid, so the outage isn't even reached — and once it
      // expires, the last known value is what gets served.
      await expect(getChatSettings()).resolves.toMatchObject({ killSwitchEnabled: true });
    } finally {
      console.error.mockRestore();
    }
  });
});

describe("setKillSwitch", () => {
  it("takes effect immediately, without waiting out the cache", async () => {
    await getChatSettings(); // warm the cache with killSwitchEnabled: false

    ChatSettings.findOneAndUpdate.mockResolvedValue({ key: "global", killSwitchEnabled: true });
    await setKillSwitch(true, "admin_1");

    const after = await getChatSettings();
    expect(after.killSwitchEnabled).toBe(true);
    // Still no extra read: flipping the switch refreshed the cache itself.
    expect(ChatSettings.findOne).toHaveBeenCalledTimes(1);
  });
});
