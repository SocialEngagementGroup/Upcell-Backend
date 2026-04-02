const admin = require("firebase-admin");

// Initialize firebase-admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(), // or use service account key if manual
  });
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;

    // Check if user is an admin
    const admins = (process.env.ADMIN_EMAILS || "").split(",");
    if (!admins.includes(decodedToken.email)) {
      return res.status(403).json({ error: "Forbidden: Not an admin" });
    }

    next();
  } catch (error) {
    console.error("Error verifying Firebase token:", error);
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

module.exports = { verifyToken };
