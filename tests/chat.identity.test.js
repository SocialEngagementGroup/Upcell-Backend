jest.mock("../src/models/chatConversation.model");

const ChatConversation = require("../src/models/chatConversation.model");
const { resolveChatIdentity, COOKIE_NAME } = require("../src/middleware/chatSession.middleware");

// SEG F-01: the server decides who the caller is. These tests exist to keep a
// future "let customers resume where they left off" feature request from
// quietly reintroducing a client-supplied session id — the exact shape of the
// trade-in quote bug the audit flagged as a habit rather than an accident.

const makeReq = (overrides = {}) => ({
  body: {},
  signedCookies: {},
  ...overrides,
});

const makeRes = () => ({
  cookie: jest.fn(),
  clearCookie: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  ChatConversation.updateMany.mockResolvedValue({});
});

describe("guest identity", () => {
  it("mints a signed HttpOnly cookie on first contact", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await resolveChatIdentity(req, res, next);

    expect(next).toHaveBeenCalledWith();
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe(COOKIE_NAME);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", signed: true });
    expect(req.chatIdentity).toEqual({ type: "guest", id: value, key: `guest:${value}` });
  });

  it("issues an opaque, non-guessable id — not a timestamp plus Math.random()", async () => {
    const ids = new Set();
    for (let i = 0; i < 50; i += 1) {
      const req = makeReq();
      await resolveChatIdentity(req, makeRes(), jest.fn());
      ids.add(req.chatIdentity.id);
      // v4 UUID from crypto.randomUUID(), not Date.now() + Math.random()
      expect(req.chatIdentity.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
    expect(ids.size).toBe(50);
  });

  it("reuses the id the server already issued", async () => {
    const req = makeReq({ signedCookies: { [COOKIE_NAME]: "existing-guest-id" } });
    await resolveChatIdentity(req, makeRes(), jest.fn());
    expect(req.chatIdentity.id).toBe("existing-guest-id");
  });

  it("ignores a sessionId supplied in the request body (F-01)", async () => {
    const req = makeReq({ body: { sessionId: "attacker-supplied-id", message: "hi" } });
    await resolveChatIdentity(req, makeRes(), jest.fn());
    expect(req.chatIdentity.id).not.toBe("attacker-supplied-id");
  });

  it("discards a tampered cookie instead of trusting it", async () => {
    // cookie-parser puts `false` in signedCookies when a signature fails.
    const req = makeReq({ signedCookies: { [COOKIE_NAME]: false } });
    await resolveChatIdentity(req, makeRes(), jest.fn());
    expect(req.chatIdentity.id).not.toBe(false);
    expect(req.chatIdentity.type).toBe("guest");
  });
});

describe("logged-in identity", () => {
  it("derives identity from the authenticated user, never the body", async () => {
    const req = makeReq({ user: { id: "user_123" }, body: { sessionId: "attacker-supplied-id" } });
    await resolveChatIdentity(req, makeRes(), jest.fn());
    expect(req.chatIdentity).toEqual({ type: "user", id: "user_123", key: "user:user_123" });
  });

  it("ignores a valid-looking guest id in the body for a logged-in caller", async () => {
    const req = makeReq({ user: { id: "user_123" }, body: { sessionId: "11111111-1111-4111-8111-111111111111" } });
    await resolveChatIdentity(req, makeRes(), jest.fn());
    expect(req.chatIdentity.type).toBe("user");
    expect(ChatConversation.updateMany).not.toHaveBeenCalled();
  });
});

describe("guest-to-logged-in transition (SEG §04)", () => {
  it("rebinds the guest transcript to the user and stops honoring the old cookie", async () => {
    const req = makeReq({
      user: { id: "user_123" },
      signedCookies: { [COOKIE_NAME]: "guest-abc" },
    });
    const res = makeRes();

    await resolveChatIdentity(req, res, jest.fn());

    expect(ChatConversation.updateMany).toHaveBeenCalledWith(
      { sessionId: "guest-abc" },
      { $set: { userId: "user_123" }, $unset: { sessionId: "" } }
    );
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ httpOnly: true }));
    expect(req.chatIdentity.type).toBe("user");
  });
});

describe("failure handling", () => {
  it("forwards a database failure instead of falling through without an identity", async () => {
    ChatConversation.updateMany.mockRejectedValue(new Error("mongo down"));
    const req = makeReq({ user: { id: "user_123" }, signedCookies: { [COOKIE_NAME]: "guest-abc" } });
    const next = jest.fn();

    await resolveChatIdentity(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(req.chatIdentity).toBeUndefined();
  });
});
