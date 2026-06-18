const { clerkClient } = require("@clerk/clerk-sdk-node");

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

    const claims = await clerkClient.verifyToken(token);
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

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
};

module.exports = { verifyToken, requireAdmin };
