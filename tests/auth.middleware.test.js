const mockVerifyToken = jest.fn();
const mockGetUser = jest.fn();

// Mirrors @clerk/express's actual shape, which differs from the retired
// @clerk/clerk-sdk-node: verifyToken is a TOP-LEVEL export, not a method on
// clerkClient (clerkClient.verifyToken is undefined there). users.getUser
// stays nested under clerkClient as before.
jest.mock("@clerk/express", () => ({
  verifyToken: (...args) => mockVerifyToken(...args),
  clerkClient: {
    users: { getUser: (...args) => mockGetUser(...args) },
  },
}));

process.env.CLERK_SECRET_KEY = "sk_test_fake";

const { verifyToken, requireAdmin, optionalAuth } = require("../src/middleware/auth.middleware");

const makeReqRes = (authorization) => {
  const req = { headers: authorization === undefined ? {} : { authorization } };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return { req, res, next };
};

// Mirrors the shape Clerk returns from users.getUser(): emailAddresses is a
// list of objects with their own ids, and primaryEmailAddressId points at one
// of them rather than carrying the address directly.
const makeClerkUser = (overrides = {}) => ({
  id: "user_123",
  primaryEmailAddressId: "idn_primary",
  emailAddresses: [
    { id: "idn_secondary", emailAddress: "secondary@example.com" },
    { id: "idn_primary", emailAddress: "primary@example.com" },
  ],
  publicMetadata: { role: "customer" },
  ...overrides,
});

beforeEach(() => {
  mockVerifyToken.mockReset().mockResolvedValue({ sub: "user_123" });
  mockGetUser.mockReset().mockResolvedValue(makeClerkUser());
});

describe("verifyToken — bearer token extraction", () => {
  it("populates req.user and calls next() for a valid Bearer token", async () => {
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    expect(mockVerifyToken).toHaveBeenCalledWith("good-token", { secretKey: "sk_test_fake" });
    expect(req.user).toEqual({ id: "user_123", email: "primary@example.com", role: "customer" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it("401s when the Authorization header is missing entirely", async () => {
    const { req, res, next } = makeReqRes();
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("401s on a non-Bearer scheme", async () => {
    const { req, res, next } = makeReqRes("Basic dXNlcjpwYXNz");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("401s when the scheme is present but the token is missing", async () => {
    const { req, res, next } = makeReqRes("Bearer");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("401s on a bare token with no scheme", async () => {
    const { req, res, next } = makeReqRes("just-a-raw-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("is case-sensitive on the scheme — 'bearer' is rejected", async () => {
    const { req, res, next } = makeReqRes("bearer good-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });
});

// Regression guard for the @clerk/express migration. Unlike clerkClient, the
// standalone verifyToken() does not fall back to process.env.CLERK_SECRET_KEY:
// omit the option and it throws "Cannot read properties of undefined (reading
// 'jwtKey')", which the middleware's catch would mask as a routine 401 —
// silently rejecting every authenticated request in production.
describe("verifyToken — secret key is always passed explicitly", () => {
  it("forwards the secret key on the protected path", async () => {
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    expect(mockVerifyToken).toHaveBeenCalledWith("good-token", { secretKey: "sk_test_fake" });
  });

  it("forwards the secret key on the optional-auth path too", async () => {
    const { req, res, next } = makeReqRes("Bearer good-token");
    await optionalAuth(req, res, next);

    expect(mockVerifyToken).toHaveBeenCalledWith("good-token", { secretKey: "sk_test_fake" });
  });

  it("never calls verifyToken with the options argument omitted", async () => {
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    const [, options] = mockVerifyToken.mock.calls[0];
    expect(options).toBeDefined();
    expect(options.secretKey).toBeTruthy();
  });

  it("reads the key at call time, so a key loaded after import is still picked up", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_rotated";
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    expect(mockVerifyToken).toHaveBeenCalledWith("good-token", { secretKey: "sk_test_rotated" });
    process.env.CLERK_SECRET_KEY = "sk_test_fake";
  });
});

describe("verifyToken — token verification failures", () => {
  it("401s and never looks the user up when the token is rejected by Clerk", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("token-invalid"));
    const { req, res, next } = makeReqRes("Bearer bad-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on an expired token", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("token-expired"));
    const { req, res, next } = makeReqRes("Bearer expired-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the verified claims carry no subject", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sid: "sess_1" });
    const { req, res, next } = makeReqRes("Bearer subjectless-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("401s when the user lookup fails after a valid token", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("user not found"));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not leak the underlying Clerk error text to the client", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("secret key sk_live_abc123 is invalid"));
    const { req, res } = makeReqRes("Bearer bad-token");
    await verifyToken(req, res, jest.fn());

    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(JSON.stringify(res.body)).not.toContain("sk_live");
  });

  it("looks the user up with the subject taken from the verified claims, not the request", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: "user_from_claims" });
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);

    expect(mockGetUser).toHaveBeenCalledWith("user_from_claims");
  });
});

describe("verifyToken — role normalization", () => {
  const roleFor = async (publicMetadata) => {
    mockGetUser.mockResolvedValueOnce(makeClerkUser({ publicMetadata }));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);
    return req.user.role;
  };

  it("lowercases the role", async () => {
    expect(await roleFor({ role: "Admin" })).toBe("admin");
  });

  it("trims surrounding whitespace", async () => {
    expect(await roleFor({ role: "  admin  " })).toBe("admin");
  });

  it("defaults to customer when the role is absent", async () => {
    expect(await roleFor({})).toBe("customer");
  });

  it("defaults to customer when publicMetadata itself is missing", async () => {
    mockGetUser.mockResolvedValueOnce(makeClerkUser({ publicMetadata: undefined }));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);
    expect(req.user.role).toBe("customer");
  });

  it("defaults to customer for a non-string role — a truthy object must not slip through", async () => {
    expect(await roleFor({ role: { admin: true } })).toBe("customer");
  });

  it("defaults to customer for a whitespace-only role", async () => {
    expect(await roleFor({ role: "   " })).toBe("customer");
  });

  it("preserves an unrecognised role rather than silently upgrading it", async () => {
    expect(await roleFor({ role: "editor" })).toBe("editor");
  });
});

describe("verifyToken — primary email resolution", () => {
  const emailFor = async (overrides) => {
    mockGetUser.mockResolvedValueOnce(makeClerkUser(overrides));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await verifyToken(req, res, next);
    return req.user.email;
  };

  it("picks the address matching primaryEmailAddressId, not merely the first", async () => {
    expect(await emailFor({})).toBe("primary@example.com");
  });

  it("falls back to the first address when the primary id matches nothing", async () => {
    expect(await emailFor({ primaryEmailAddressId: "idn_missing" })).toBe("secondary@example.com");
  });

  it("falls back to the first address when there is no primary id at all", async () => {
    expect(await emailFor({ primaryEmailAddressId: undefined })).toBe("secondary@example.com");
  });

  it("resolves to null when the user has no email addresses", async () => {
    expect(await emailFor({ emailAddresses: [] })).toBeNull();
  });

  it("resolves to null when emailAddresses is missing entirely", async () => {
    expect(await emailFor({ emailAddresses: undefined })).toBeNull();
  });
});

describe("requireAdmin", () => {
  const runWith = (user) => {
    const { req, res, next } = makeReqRes();
    req.user = user;
    requireAdmin(req, res, next);
    return { res, next };
  };

  it("calls next() for an admin", () => {
    const { res, next } = runWith({ id: "user_123", role: "admin" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it("403s a customer", () => {
    const { res, next } = runWith({ id: "user_123", role: "customer" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });

  it("403s when req.user is absent — an unauthenticated request must not pass", () => {
    const { res, next } = runWith(undefined);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s an unrecognised role", () => {
    const { res, next } = runWith({ id: "user_123", role: "editor" });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  // requireAdmin compares against the already-normalized role that verifyToken
  // wrote. It deliberately does not re-normalize, so a raw uppercase value
  // reaching it would mean verifyToken was bypassed — which must fail closed.
  it("403s an un-normalized 'ADMIN' — it trusts verifyToken to have normalized first", () => {
    const { res, next } = runWith({ id: "user_123", role: "ADMIN" });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("optionalAuth", () => {
  it("continues anonymously when no token is supplied", async () => {
    const { req, res, next } = makeReqRes();
    await optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("populates req.user for a valid token", async () => {
    const { req, res, next } = makeReqRes("Bearer good-token");
    await optionalAuth(req, res, next);

    expect(req.user).toEqual({ id: "user_123", email: "primary@example.com", role: "customer" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("normalizes the role the same way verifyToken does", async () => {
    mockGetUser.mockResolvedValueOnce(makeClerkUser({ publicMetadata: { role: "Admin" } }));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await optionalAuth(req, res, next);

    expect(req.user.role).toBe("admin");
  });

  it("continues anonymously on an invalid token instead of 401ing", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("token-invalid"));
    const { req, res, next } = makeReqRes("Bearer bad-token");
    await optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(res.statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("continues anonymously on an expired token", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("token-expired"));
    const { req, res, next } = makeReqRes("Bearer expired-token");
    await optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("continues anonymously when the user lookup fails", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("clerk is down"));
    const { req, res, next } = makeReqRes("Bearer good-token");
    await optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("continues anonymously when the claims carry no subject", async () => {
    mockVerifyToken.mockResolvedValueOnce({ sid: "sess_1" });
    const { req, res, next } = makeReqRes("Bearer subjectless-token");
    await optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() exactly once on the failure path — no double-dispatch", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("token-invalid"));
    const { req, res, next } = makeReqRes("Bearer bad-token");
    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
