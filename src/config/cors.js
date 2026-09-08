const splitOrigins = (value) => {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .map((origin) => origin.replace(/\/$/, ""))
    .filter(Boolean);
};

const defaultOrigins = [
  "http://localhost:5173",
  "https://upcellit.com",
  "https://www.upcellit.com",
];

const authorizedOrigins = [
  ...defaultOrigins,
  ...splitOrigins(process.env.FRONTEND_URL),
  ...splitOrigins(process.env.FRONTEND_ORIGINS),
].filter(Boolean);

const defaultPatterns = [
  /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/,
];

const authorizedOriginPatterns = [
  ...defaultPatterns,
  ...splitOrigins(process.env.FRONTEND_ORIGIN_PATTERNS).map((pattern) => new RegExp(pattern)),
];

const isAuthorizedOrigin = (origin) => (
  authorizedOrigins.includes(origin)
  || authorizedOriginPatterns.some((pattern) => pattern.test(origin))
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isAuthorizedOrigin(origin)) {
      callback(null, true);
    } else {
      console.error(`CORS rejected origin: ${origin}`);
      const corsError = new Error("Not allowed by CORS");
      // A rejected origin is a client/config problem, not a server failure —
      // without this the global error handler defaults to 500 and pages the
      // admin as if the site were broken.
      corsError.status = 403;
      callback(corsError);
    }
  },
  credentials: true,
};

module.exports = { corsOptions };
