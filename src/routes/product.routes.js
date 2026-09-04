const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { cartLimiter } = require("../middleware/rateLimit.middleware");
const { productCreateSchema, productSchema, productFilterSchema } = require("../schemas/request.schemas");
const {
  getProducts,
  getAdminProducts,
  getProduct,
  getProductsByParent,
  getShopProducts,
  getRecommendedProducts,
  getProductSuggestions,
  getFilteredProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteProductFamily,
  getRepresentativeProducts,
  getAccessories,
} = require("../controllers/product.controller");

router.get("/product", getProducts);
// AllProduct/AddProduct's own lean data source — see getAdminProducts.
router.get("/admin-products", verifyToken, requireAdmin, getAdminProducts);
router.get("/products/shop", getShopProducts);
router.get("/products/recommended", getRecommendedProducts);
router.get("/product/:id", validateObjectIdParam(), getProduct);
router.get("/allSameParentProducts/:parentId", getProductsByParent);
router.get("/products/suggest", getProductSuggestions);
router.post("/products/:n/:skip", cartLimiter, validateRequest(productFilterSchema), getFilteredProducts);
router.post("/product", verifyToken, requireAdmin, validateRequest(productCreateSchema), createProduct);
router.patch(
  "/product/:id",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(productSchema.partial()),
  updateProduct
);
router.delete("/product/:id", verifyToken, requireAdmin, validateObjectIdParam(), deleteProduct);
router.delete("/product-family/:parentId", verifyToken, requireAdmin, deleteProductFamily);
router.get("/all-products-single-variation", getRepresentativeProducts);
// Public: the add-ons shown on a product page.
router.get("/accessories", getAccessories);

module.exports = router;
