const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const { categorySchema } = require("../schemas/request.schemas");
const {
  getCategories,
  getCategoryById,
  getShopCategories,
  getAvailableCategories,
  createCategory,
  createShopCategory,
  updateCategory,
  updateShopCategory,
  deleteCategory,
  deleteShopCategory,
} = require("../controllers/category.controller");

router.get("/catagory", getCategories);
router.get("/catagory/:id", validateObjectIdParam(), getCategoryById);
router.get("/shop-categories", getShopCategories);
router.get("/available-catagories", getAvailableCategories);
router.post("/catagory", verifyToken, requireAdmin, validateRequest(categorySchema), createCategory);
router.post("/shop-categories", verifyToken, requireAdmin, validateRequest(categorySchema), createShopCategory);
router.patch(
  "/catagory/:id",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(categorySchema.partial()),
  updateCategory
);
router.patch(
  "/shop-categories/:id",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  validateRequest(categorySchema.partial()),
  updateShopCategory
);
router.delete("/catagory/:id", verifyToken, requireAdmin, validateObjectIdParam(), deleteCategory);
router.delete("/shop-categories/:id", verifyToken, requireAdmin, validateObjectIdParam(), deleteShopCategory);

module.exports = router;
