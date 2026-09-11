const router = require("express").Router();
const { cartLimiter } = require("../middleware/rateLimit.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { verifyToken } = require("../middleware/auth.middleware");
const { cartLookupSchema } = require("../schemas/request.schemas");
const { getCartProducts, getMyCart, putMyCart } = require("../controllers/cart.controller");

router.post("/cart", cartLimiter, validateRequest(cartLookupSchema), getCartProducts);

// The saved cart of a signed-in customer. Guests keep theirs in the browser,
// which is all a guest has.
router.get("/cart/mine", verifyToken, getMyCart);
router.put("/cart/mine", verifyToken, cartLimiter, putMyCart);

module.exports = router;
