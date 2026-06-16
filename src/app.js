require("dotenv").config();

const express = require("express");
const cors = require("cors");
const routes = require("./routes");
const { corsOptions } = require("./config/cors");
const { errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(cors(corsOptions));

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(routes);
app.use(errorHandler);

module.exports = app;
