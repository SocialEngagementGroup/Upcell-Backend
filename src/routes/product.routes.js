const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { cartLimiter } = require("../middleware/rateLimit.middleware");
const {
  productCreateSchema,
  productSchema,
  productFilterSchema,
  productImportSchema,
} = require("../schemas/request.schemas");
const {
  getAdminProducts,
  getProduct,
  getProductsByParent,
  getProductBySlug,
  getShopProducts,
  getRecommendedProducts,
  getProductSuggestions,
  getFilteredProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteProductFamily,
  getAccessories,
} = require("../controllers/product.controller");
const { importProducts, getStockSummary } = require("../controllers/productImport.controller");

// AllProduct/AddProduct's own lean data source — see getAdminProducts.
router.get("/admin-products", verifyToken, requireAdmin, getAdminProducts);
// A pallet of stock, from a spreadsheet. dryRun:true reports what would
// happen and writes nothing.
router.post("/admin-products/import", verifyToken, requireAdmin, validateRequest(productImportSchema), importProducts);
// How much of the catalogue can actually be sold, by family. Not the same as
// how much is in the building — see the controller.
router.get("/admin-stock-summary", verifyToken, requireAdmin, getStockSummary);
router.get("/products/shop", getShopProducts);
router.get("/products/recommended", getRecommendedProducts);
router.get("/product/:id", validateObjectIdParam(), getProduct);
router.get("/allSameParentProducts/:parentId", getProductsByParent);
// Readable URLs. The id route above stays so links already in the wild, and any
// client mid-deploy, keep working.
// One readable segment: /products/by-slug/iphone-air-256gb-space-black.
// Sits under /products/ so it cannot collide with the admin DELETE
// /product-family/:parentId below, which takes an id and means something else.
router.get("/products/by-slug/:slug", getProductBySlug);
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
// Public: the add-ons shown on a product page.
router.get("/accessories", getAccessories);

module.exports = router;
