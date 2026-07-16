const router = require("express").Router();
const { cartLimiter } = require("../middleware/rateLimit.middleware");
const { getCartProducts } = require("../controllers/cart.controller");

router.post("/cart", cartLimiter, getCartProducts);

module.exports = router;
