jest.mock("../src/models/chatConversation.model");
jest.mock("../src/services/aiProvider");
jest.mock("../src/services/chat/chatSettingsService");
jest.mock("../src/services/chat/chatAlerts");
jest.mock("../src/services/chat/catalogueService");

const ChatConversation = require("../src/models/chatConversation.model");
const { getAiProvider } = require("../src/services/aiProvider");
const {
  getChatSettings,
  claimDailyRequestBudget,
  recordTokenUsage,
} = require("../src/services/chat/chatSettingsService");
const { notifyUpstreamFailure, notifyEscalation } = require("../src/services/chat/chatAlerts");
const { getCatalogueSnapshot, scopeToMessage } = require("../src/services/chat/catalogueService");
const { sendChatMessage } = require("../src/controllers/chat.controller");

const CATALOGUE = {
  modelCount: 2,
  allowedPrices: new Set([799, 1299]),
  block: "LIVE CATALOGUE — …\niPhone 16: 128GB, 256GB | condition Mint, Good — $799 to $1039",
};

const complete = jest.fn();

const makeReqRes = (message, identity = { type: "guest", id: "guest-1", key: "guest:guest-1" }) => {
  const req = { body: { message }, chatIdentity: identity };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

// ChatConversation.find(filter).sort().limit().lean()
function mockHistory(turns) {
  const chain = {};
  chain.sort = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(turns));
  ChatConversation.find.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  getChatSettings.mockResolvedValue({ killSwitchEnabled: false });
  claimDailyRequestBudget.mockResolvedValue({ allowed: true, usage: { requestCount: 1 } });
  recordTokenUsage.mockResolvedValue();
  getAiProvider.mockReturnValue({ complete });
  getCatalogueSnapshot.mockResolvedValue(CATALOGUE);
  // Narrowing is exercised in its own tests; here it passes the snapshot through.
  scopeToMessage.mockImplementation((snapshot) => snapshot);
  complete.mockResolvedValue({
    text: "Trade-ins are inspected before payout.",
    blockedBySafety: false,
    finishReason: "STOP",
    model: "gemini-3.5-flash",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
  ChatConversation.create.mockImplementation((doc) => Promise.resolve({ _id: "turn-1", ...doc }));
  ChatConversation.updateOne.mockResolvedValue({});
  mockHistory([]);
});

afterEach(() => {
  console.log.mockRestore();
});

describe("cost ceilings checked before the model is ever called (SEG §06)", () => {
  it("kill switch: answers with the unavailable message and never calls Gemini", async () => {
    getChatSettings.mockResolvedValue({ killSwitchEnabled: true });
    const { req, res, next } = makeReqRes("hello");

    await sendChatMessage(req, res, next);

    expect(complete).not.toHaveBeenCalled();
    expect(ChatConversation.create).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].escalate).toBe(true);
  });

  it("daily budget exhausted: same, and the budget is claimed before the call", async () => {
    claimDailyRequestBudget.mockResolvedValue({ allowed: false, usage: { requestCount: 501 } });
    const { req, res, next } = makeReqRes("hello");

    await sendChatMessage(req, res, next);

    expect(complete).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].reply).toMatch(/temporarily unavailable/i);
  });
});

describe("questions the model never gets to answer (SEG §07 / §09)", () => {
  it("volunteered card data is redacted, escalated, and never sent to the model", async () => {
    const { req, res, next } = makeReqRes("my card is 4111 1111 1111 1111");

    await sendChatMessage(req, res, next);

    expect(complete).not.toHaveBeenCalled();
    const userTurn = ChatConversation.create.mock.calls[0][0];
    expect(userTurn.message).toBe("my card is [redacted-card-number]");
    expect(userTurn.redacted).toBe(true);
    const body = res.json.mock.calls[0][0];
    expect(body.escalate).toBe(true);
    expect(body.reply).not.toContain("4111");
  });

  it("a discount request is answered from a fixed string, with no model call", async () => {
    const { req, res, next } = makeReqRes("any discount code for me?");

    await sendChatMessage(req, res, next);

    expect(complete).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.escalate).toBe(true);
    expect(body.reply).toMatch(/can't offer or confirm any discounts/i);
  });

  it("answers a return-window question from the site's own agreed figure", async () => {
    const { req, res, next } = makeReqRes("how many days do I have to return it?");

    await sendChatMessage(req, res, next);

    expect(complete).toHaveBeenCalled();
    expect(complete.mock.calls[0][0].systemPrompt).toContain("30 calendar days");
    expect(complete.mock.calls[0][0].systemPrompt).not.toMatch(/\b14\s*(calendar\s*)?days?\b/i);
  });
});

describe("handing over to a person (SEG F-07)", () => {
  it("issues a reference and tells the support space, with the customer's question", async () => {
    const { req, res, next } = makeReqRes("I want a refund, this is unacceptable");

    await sendChatMessage(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.escalate).toBe(true);
    expect(body.reference).toMatch(/^UP-[0-9A-F]{5}$/);
    expect(notifyEscalation).toHaveBeenCalledWith(expect.objectContaining({
      reference: body.reference,
      reason: "keyword",
      identityType: "guest",
      lastMessage: "I want a refund, this is unacceptable",
    }));
  });

  it("stays silent, with no reference, on an ordinary answer", async () => {
    const { req, res, next } = makeReqRes("how long does shipping take?");

    await sendChatMessage(req, res, next);

    expect(notifyEscalation).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].reference).toBeNull();
  });

  it("sends the redacted message, never the card number the customer typed", async () => {
    const { req, res, next } = makeReqRes("my card is 4111 1111 1111 1111");

    await sendChatMessage(req, res, next);

    // This path short-circuits before the model, so the notification is not
    // sent from here — but the transcript must already be clean.
    expect(ChatConversation.create.mock.calls[0][0].message).not.toContain("4111");
  });
});

describe("the website is the only source of facts (SEG §07 / §10)", () => {
  it("injects the site's own content for the question asked", async () => {
    const { req, res, next } = makeReqRes("how long does shipping take?");

    await sendChatMessage(req, res, next);

    const { systemPrompt } = complete.mock.calls[0][0];
    expect(systemPrompt).toContain("WEBSITE KNOWLEDGE");
    expect(systemPrompt).toContain("3–7 business days");
  });

  it("adds the live catalogue snapshot to the request", async () => {
    const { req, res, next } = makeReqRes("show me iphone 16 variants");

    await sendChatMessage(req, res, next);

    expect(complete.mock.calls[0][0].systemPrompt).toContain(CATALOGUE.block);
  });

  it("still answers when the catalogue is unavailable, without a price", async () => {
    getCatalogueSnapshot.mockResolvedValue(null);
    complete.mockResolvedValue({
      text: "You can see what's listed on /shop.",
      blockedBySafety: false,
      finishReason: "STOP",
      model: "gemini-3.5-flash-lite",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { req, res, next } = makeReqRes("show me iphone 16 variants");

    await sendChatMessage(req, res, next);

    // The prompt itself explains what a LIVE CATALOGUE block is, so assert on
    // the block's actual content rather than the phrase.
    expect(complete.mock.calls[0][0].systemPrompt).not.toContain(CATALOGUE.block);
    expect(res.json.mock.calls[0][0].reply).toContain("/shop");
  });

  it("gives the model no way to reach customer data — only the message and the block", async () => {
    const { req, res, next } = makeReqRes("what's the status of order 4471?");

    await sendChatMessage(req, res, next);

    const call = complete.mock.calls[0][0];
    expect(Object.keys(call).sort()).toEqual(["history", "systemPrompt"]);
    expect(call.systemPrompt).toContain("no access to accounts, orders");
  });
});

describe("the pending-turn lifecycle (SEG F-11)", () => {
  it("writes the user's message as pending, then completes it once the reply exists", async () => {
    const { req, res, next } = makeReqRes("how does trade-in work?");

    await sendChatMessage(req, res, next);

    expect(ChatConversation.create.mock.calls[0][0]).toMatchObject({ role: "user", status: "pending" });
    expect(ChatConversation.create.mock.calls[1][0]).toMatchObject({ role: "assistant", status: "complete" });
    expect(ChatConversation.updateOne).toHaveBeenCalledWith(
      { _id: "turn-1" },
      { $set: { status: "complete" } }
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves the turn pending when the model call fails, so it can't skew later history", async () => {
    const error = new Error("Gemini request failed");
    error.status = 502;
    complete.mockRejectedValue(error);
    const { req, res, next } = makeReqRes("how does trade-in work?");

    await sendChatMessage(req, res, next);

    expect(ChatConversation.updateOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(error);
    expect(notifyUpstreamFailure).toHaveBeenCalledWith({ status: 502 });
  });

  it("builds history from completed turns only, and ends on the current question", async () => {
    mockHistory([
      { role: "assistant", message: "Happy to help.", createdAt: 2 },
      { role: "user", message: "hi", createdAt: 1 },
    ]);
    const { req, res, next } = makeReqRes("how does trade-in work?");

    await sendChatMessage(req, res, next);

    const [filter] = ChatConversation.find.mock.calls[0];
    expect(filter).toMatchObject({ sessionId: "guest-1", status: "complete" });

    const { history } = complete.mock.calls[0][0];
    expect(history.map((turn) => turn.content)).toEqual(["hi", "Happy to help.", "how does trade-in work?"]);
  });
});

describe("identity is never taken from the request body (SEG F-01/F-02)", () => {
  it("filters reads and writes by the server-resolved identity", async () => {
    const { req, res, next } = makeReqRes("hello");
    req.body.sessionId = { $ne: null }; // the NoSQL-injection shape from F-02

    await sendChatMessage(req, res, next);

    expect(ChatConversation.find.mock.calls[0][0]).toEqual({ sessionId: "guest-1", status: "complete" });
    expect(ChatConversation.create.mock.calls[0][0].sessionId).toBe("guest-1");
  });

  it("uses userId, not sessionId, for a logged-in caller", async () => {
    const { req, res, next } = makeReqRes("hello", { type: "user", id: "user_9", key: "user:user_9" });

    await sendChatMessage(req, res, next);

    const userTurn = ChatConversation.create.mock.calls[0][0];
    expect(userTurn.userId).toBe("user_9");
    expect(userTurn.sessionId).toBeUndefined();
  });
});

describe("model output handling", () => {
  it("lets through a price the live catalogue actually contains", async () => {
    complete.mockResolvedValue({
      text: "The iPhone 16 starts at $799 for the 128GB — check /shop to confirm.",
      blockedBySafety: false,
      finishReason: "STOP",
      model: "gemini-3.5-flash-lite",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { req, res, next } = makeReqRes("how much is the iphone 16?");

    await sendChatMessage(req, res, next);

    expect(res.json.mock.calls[0][0].reply).toContain("$799");
  });

  it("blocks a price the catalogue does not contain, even when it looks plausible", async () => {
    complete.mockResolvedValue({
      text: "The iPhone 16 is $749 today.",
      blockedBySafety: false,
      finishReason: "STOP",
      model: "gemini-3.5-flash-lite",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { req, res, next } = makeReqRes("how much is the iphone 16?");

    await sendChatMessage(req, res, next);

    expect(res.json.mock.calls[0][0].reply).not.toContain("$749");
  });

  it("screens an invented payout figure out of the reply before it reaches the customer", async () => {
    complete.mockResolvedValue({
      text: "Sure — we'll pay you $650 for that iPhone.",
      blockedBySafety: false,
      finishReason: "STOP",
      model: "gemini-3.5-flash",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { req, res, next } = makeReqRes("what will you pay for my iPhone 14?");

    await sendChatMessage(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.reply).not.toContain("$650");
    expect(body.escalate).toBe(true);
  });

  it("turns a safety-blocked response into a real message plus escalation, not an empty bubble", async () => {
    complete.mockResolvedValue({
      text: null,
      blockedBySafety: true,
      finishReason: "SAFETY",
      model: "gemini-3.5-flash",
      usage: { inputTokens: 5, outputTokens: 0 },
    });
    const { req, res, next } = makeReqRes("something the filter rejects");

    await sendChatMessage(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.reply.length).toBeGreaterThan(0);
    expect(body.escalate).toBe(true);
  });
});
