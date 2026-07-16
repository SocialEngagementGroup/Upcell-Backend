const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { wholesaleFormSubmit, getAdminAddForms, deleteAddForm } = require("../controllers/wholesale.controller");

router.post("/", publicFormLimiter, wholesaleFormSubmit);
router.get("/admin/:filter", verifyToken, requireAdmin, getAdminAddForms);
router.delete("/admin/:id", verifyToken, requireAdmin, deleteAddForm);

module.exports = router;
