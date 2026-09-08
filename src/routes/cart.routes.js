const router = require("express").Router();
const { cartLimiter } = require("../middleware/rateLimit.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { cartLookupSchema } = require("../schemas/request.schemas");
const { getCartProducts } = require("../controllers/cart.controller");

router.post("/cart", cartLimiter, validateRequest(cartLookupSchema), getCartProducts);

module.exports = router;
