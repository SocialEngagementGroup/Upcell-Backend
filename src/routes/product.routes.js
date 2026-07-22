const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { productCreateSchema, productSchema, productFilterSchema } = require("../schemas/request.schemas");
const {
  getProducts,
  getProduct,
  getProductsByParent,
  getShopProducts,
  getRecommendedProducts,
  searchProducts,
  getProductSuggestions,
  getFilteredProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteProductFamily,
  getRepresentativeProducts,
} = require("../controllers/product.controller");

router.get("/product", getProducts);
router.get("/products/shop", getShopProducts);
router.get("/products/recommended", getRecommendedProducts);
router.get("/product/:id", getProduct);
router.get("/allSameParentProducts/:parentId", getProductsByParent);
router.get("/searchproducts", searchProducts);
router.get("/products/suggest", getProductSuggestions);
router.post("/products/:n/:skip", validateRequest(productFilterSchema), getFilteredProducts);
router.post("/product", verifyToken, requireAdmin, validateRequest(productCreateSchema), createProduct);
router.patch("/product/:id", verifyToken, requireAdmin, validateRequest(productSchema.partial()), updateProduct);
router.delete("/product/:id", verifyToken, requireAdmin, deleteProduct);
router.delete("/product-family/:parentId", verifyToken, requireAdmin, deleteProductFamily);
router.get("/all-products-single-variation", getRepresentativeProducts);

module.exports = router;
