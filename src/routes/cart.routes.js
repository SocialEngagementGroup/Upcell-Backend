const router = require("express").Router();
const { getCartProducts } = require("../controllers/cart.controller");

router.post("/cart", getCartProducts);

module.exports = router;
