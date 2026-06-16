const authorizedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL,
];

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
