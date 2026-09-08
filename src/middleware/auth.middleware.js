// @clerk/express replaces @clerk/clerk-sdk-node, which reached end of support
// on 2025-01-10 and no longer receives security patches.
// Aliased on import because this module exports its own verifyToken middleware.
const { clerkClient, verifyToken: verifyClerkToken } = require("@clerk/express");
const { adminLimiter } = require("./rateLimit.middleware");

// clerkClient picks CLERK_SECRET_KEY up from the environment on its own, but
// verifyToken() does NOT — called without an explicit secretKey it throws a
// TypeError, which the catch blocks below would quietly turn into a 401 on
// every single request. So the key is passed explicitly on every call.
// Read per-call rather than at import time so the value is whatever dotenv has
// loaded by the time a request actually arrives, not whatever was set when this
// module happened to be required.
function getVerifyOptions() {
  return { secretKey: process.env.CLERK_SECRET_KEY };
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function getPrimaryEmail(user) {
  const primaryEmail = user.emailAddresses?.find(
    (email) => email.id === user.primaryEmailAddressId
  );

  return primaryEmail?.emailAddress || user.emailAddresses?.[0]?.emailAddress || null;
}

function normalizeRole(role) {
  if (typeof role !== "string") {
    return "customer";
  }

  return role.trim().toLowerCase() || "customer";
}

const verifyToken = async (req, res, next) => {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const claims = await verifyClerkToken(token, getVerifyOptions());
    const userId = claims.sub;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const clerkUser = await clerkClient.users.getUser(userId);
    const role = normalizeRole(clerkUser.publicMetadata?.role);

    req.user = {
      id: clerkUser.id,
      email: getPrimaryEmail(clerkUser),
      role,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

// Rate-limited here, once, rather than added to each of the 16 route files
// individually — requireAdmin already runs on every single admin-gated route
// with zero exceptions (confirmed 2026-09-04), so this is the one place that
// guarantees coverage without relying on every future route remembering to
// add it. Not meant to catch normal admin usage — see adminLimiter's own
// comment for why 300/15min was chosen.
const requireAdmin = (req, res, next) => {
  adminLimiter(req, res, (err) => {
    if (err) return next(err);

    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  });
};

const optionalAuth = async (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return next();
  }

  try {
    const claims = await verifyClerkToken(token, getVerifyOptions());
    const userId = claims.sub;

    if (userId) {
      const clerkUser = await clerkClient.users.getUser(userId);
      req.user = {
        id: clerkUser.id,
        email: getPrimaryEmail(clerkUser),
        role: normalizeRole(clerkUser.publicMetadata?.role),
      };
    }
  } catch (error) {
    // Invalid/expired token on an optional-auth route: treat as anonymous.
  }

  next();
};

module.exports = { verifyToken, requireAdmin, optionalAuth };
