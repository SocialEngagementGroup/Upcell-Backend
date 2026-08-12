const requiredEnvVars = [
  "MONGODB_URL",
  "CLERK_SECRET_KEY",
  "RESEND_KEY",
  "PORT",
  "FRONTEND_URL",
  "FRONTEND_ORIGINS",
  "ADMIN_NOTIFICATION_EMAIL",
  "EMAIL_FROM",
  // Signs the guest chat-session cookie (SEG F-01) — without a real secret
  // here, guest identity cookies would be forgeable.
  "CHAT_SESSION_SECRET",
];

function hasEnvValue(name) {
  return Boolean(process.env[name] && process.env[name].trim());
}

function validateEnv() {
  const missing = requiredEnvVars.filter((name) => !hasEnvValue(name));

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  }
}

module.exports = { validateEnv };
