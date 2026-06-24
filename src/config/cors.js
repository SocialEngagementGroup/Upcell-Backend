const splitOrigins = (value) => {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .map((origin) => origin.replace(/\/$/, ""))
    .filter(Boolean);
};

const authorizedOrigins = [
  "http://localhost:5173",
  ...splitOrigins(process.env.FRONTEND_URL),
  ...splitOrigins(process.env.FRONTEND_ORIGINS),
].filter(Boolean);

const authorizedOriginPatterns = [
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
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

module.exports = { corsOptions };
