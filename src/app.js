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

app.use(
  express.json({
    // Product images are currently sent as base64 data URLs in the JSON body
    // (see AddProduct/ProductBatchForm) — the default 100kb limit rejects
    // almost any image upload with a 413, so this needs to be generous.
    limit: "25mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(routes);
app.use(errorHandler);

module.exports = app;
