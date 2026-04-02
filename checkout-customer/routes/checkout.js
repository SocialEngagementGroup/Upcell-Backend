const route = require("express").Router();
const { paypalCheckout, capturePayment } = require("../controllers/checkout");
const { validateRequest } = require("../../middleware/validate");
const { orderSchema } = require("../../middleware/schemas");

route.post("/", validateRequest(orderSchema), paypalCheckout);

route.post("/capture", capturePayment);

module.exports = route;
