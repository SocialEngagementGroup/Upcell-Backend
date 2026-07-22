require("dotenv").config();

const express = require("express");
const cors = require("cors");
const routes = require("./routes");
const { corsOptions } = require("./config/cors");
const { errorHandler } = require("./middleware/error.middleware");

const app = express();

// Render (and most PaaS hosts) put the app behind a reverse proxy, so
// Express needs this to read the real client IP from X-Forwarded-For —
// otherwise every request looks like it comes from the proxy and
// IP-based rate limiting effectively applies to all users at once.
app.set("trust proxy", 1);

app.use(cors(corsOptions));

// Product/category images are sent as base64 data URLs in the JSON body
// (see AddProduct/ProductBatchForm) — those specific admin write routes need
// a generous limit. Applying that same 25mb ceiling to every route (the
// previous behavior) let any public unauthenticated endpoint — contact form,
// checkout, wholesale — also accept 25mb payloads, which is an easy memory-
// pressure lever for an attacker. Everything else gets a much smaller cap.
const LARGE_BODY_ROUTES = [
  /^\/product(\/[^/]+)?$/,
  /^\/catagory(\/[^/]+)?$/,
  /^\/shop-categories(\/[^/]+)?$/,
];
const jsonBodyParser = (limit) =>
  express.json({
    limit,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  });
const largeBodyParser = jsonBodyParser("25mb");
const defaultBodyParser = jsonBodyParser("2mb");

app.use((req, res, next) => {
  const parser = LARGE_BODY_ROUTES.some((pattern) => pattern.test(req.path))
    ? largeBodyParser
    : defaultBodyParser;
  parser(req, res, next);
});

app.use(routes);
app.use(errorHandler);

module.exports = app;
