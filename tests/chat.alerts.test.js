const originalWebhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.example.test/hook";

const { notifyBudgetUsage, notifyUpstreamFailure } = require("../src/services/chat/chatAlerts");

// SEG §11: "the first sign of abuse is almost always a cost graph, not a
// security alert." These assert the threshold arithmetic — an alert that fires
// on every request gets muted, and one that never fires is the same as absent.

// npm test runs --runInBand, so every suite shares one process — put the
// globals back rather than leaving a stubbed fetch behind for whatever runs
// next.
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterAll(() => {
  global.fetch = realFetch;
  if (originalWebhookUrl === undefined) delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
  else process.env.GOOGLE_CHAT_WEBHOOK_URL = originalWebhookUrl;
});

const budget = 500;

describe("notifyBudgetUsage", () => {
  it("fires exactly on the request that crosses 50%", () => {
    expect(notifyBudgetUsage({ previousCount: 249, currentCount: 250, budget })).toBe(50);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("stays quiet in between thresholds", () => {
    expect(notifyBudgetUsage({ previousCount: 260, currentCount: 261, budget })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fires at 80% and at 100%, and says the model is no longer being called", () => {
    expect(notifyBudgetUsage({ previousCount: 399, currentCount: 400, budget })).toBe(80);
    expect(notifyBudgetUsage({ previousCount: 499, currentCount: 500, budget })).toBe(100);
    const lastBody = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(lastBody.text).toMatch(/NOT calling Gemini/);
  });

  it("does not re-alert once past a threshold it already reported", () => {
    notifyBudgetUsage({ previousCount: 500, currentCount: 501, budget });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("is inert when no budget is configured", () => {
    expect(notifyBudgetUsage({ previousCount: 0, currentCount: 1, budget: 0 })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("notifyUpstreamFailure", () => {
  // The throttle is module-level state with a 30-minute window, so this is one
  // test rather than two — a second `it` would find the alert already sent.
  it("throttles a burst of failures to one message, and leaks nothing into it", () => {
    notifyUpstreamFailure({ status: 502 });
    notifyUpstreamFailure({ status: 502 });
    notifyUpstreamFailure({ status: 429 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toMatch(/failing upstream/i);
    expect(body.text).not.toMatch(/AIza|apiKey|sessionId/);
  });
});
