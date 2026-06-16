const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { categorySchema } = require("../schemas/request.schemas");
const {
  getCategories,
  getShopCategories,
  getAvailableCategories,
  makeAvailableCategories,
  createCategory,
  createShopCategory,
  updateCategory,
  updateShopCategory,
  deleteCategory,
  deleteShopCategory,
} = require("../controllers/category.controller");

router.get("/catagory", getCategories);
router.get("/shop-categories", getShopCategories);
router.get("/available-catagories", getAvailableCategories);
router.get("/mka", verifyToken, requireAdmin, makeAvailableCategories);
router.post("/catagory", verifyToken, requireAdmin, validateRequest(categorySchema), createCategory);
router.post("/shop-categories", verifyToken, requireAdmin, validateRequest(categorySchema), createShopCategory);
router.patch("/catagory/:id", verifyToken, requireAdmin, validateRequest(categorySchema.partial()), updateCategory);
router.patch("/shop-categories/:id", verifyToken, requireAdmin, validateRequest(categorySchema.partial()), updateShopCategory);
router.delete("/catagory/:id", verifyToken, requireAdmin, deleteCategory);
router.delete("/shop-categories/:id", verifyToken, requireAdmin, deleteShopCategory);

module.exports = router;
