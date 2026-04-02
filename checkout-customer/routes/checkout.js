const route = require("express").Router();
const { paypalCheckout, capturePaymnet } = require("../controllers/checkout");
const { validateRequest } = require("../../middleware/validate");
const { orderSchema } = require("../../middleware/schemas");

route.post("/", validateRequest(orderSchema), paypalCheckout);

route.post("/capture", capturePaymnet);

module.exports = route;
