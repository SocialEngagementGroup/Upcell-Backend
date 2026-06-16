const splitOrigins = (value) => {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const authorizedOrigins = [
  "http://localhost:5173",
  "https://upcell-frontend-git-dev-sunit-segs-projects-747dd246.vercel.app",
  "https://upcell-frontend-7auu9wwd1-segs-projects-747dd246.vercel.app",
  ...splitOrigins(process.env.FRONTEND_URL),
  ...splitOrigins(process.env.FRONTEND_ORIGINS),
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || authorizedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

module.exports = { corsOptions };
