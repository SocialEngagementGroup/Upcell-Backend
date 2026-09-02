require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const routes = require("./routes");
const { corsOptions } = require("./config/cors");
const { errorHandler } = require("./middleware/error.middleware");

const app = express();

// Render (and most PaaS hosts) put the app behind a reverse proxy, so
// Express needs this to read the real client IP from X-Forwarded-For —
// otherwise every request looks like it comes from the proxy and
// IP-based rate limiting effectively applies to all users at once.
app.set("trust proxy", 1);

// Security headers. This server answers with JSON and redirects, never HTML,
// so the settings below are the ones that actually apply to an API — the page
// headers that matter to a browser (including the Content-Security-Policy) are
// set by Vercel for the site itself, in Frontend/vercel.json.
app.use(
  helmet({
    // No CSP here. A policy on a JSON response governs nothing, and the one
    // that does matter belongs on the origin serving the pages.
    contentSecurityPolicy: false,

    // Helmet defaults this to same-origin, which would stop the shop — hosted
    // on a different domain — from reading any response this API returns.
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // Two years, subdomains included. Render already serves HTTPS only; this
    // tells the browser to refuse plain HTTP for this host without asking.
    hsts: { maxAge: 63072000, includeSubDomains: true },

    // Send the origin but not the path to other sites. An order id sitting in
    // a URL should not travel in a Referer header to a third party.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },

    // Helmet defaults to SAMEORIGIN. Nothing should ever frame an API, so say
    // so outright rather than allowing a case we do not use.
    frameguard: { action: "deny" },
  })
);

// The payment gateway's callbacks arrive as cross-site form POSTs from the
// bank's own domain, so they carry an Origin header our allow-list will never
// contain — and CORS rejects them before any route runs. That silently breaks
// the payment return: the bank takes the money, the customer lands on a JSON
// error, and the confirmation never reaches us.
//
// Skipping CORS here costs nothing. CORS stops another site's JavaScript from
// reading our responses; these two routes return a bare 200 and a redirect,
// and both verify an HMAC signature before doing anything. The signature is
// the access control, not the origin.
//
// /boa/prepare-payment is deliberately NOT in this list — that one is called
// by our own frontend and should stay behind CORS.
const GATEWAY_CALLBACK_PATHS = ["/boa/merchant-post", "/boa/response"];
const corsMiddleware = cors(corsOptions);

app.use((req, res, next) => {
  if (GATEWAY_CALLBACK_PATHS.includes(req.path)) return next();
  return corsMiddleware(req, res, next);
});

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
