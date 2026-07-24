const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { publicFormLimiter } = require("../middleware/rateLimit.middleware");
const { wholesaleFormSchema } = require("../schemas/request.schemas");
const { wholesaleFormSubmit, getAdminAddForms, deleteAddForm } = require("../controllers/wholesale.controller");

router.post("/", publicFormLimiter, validateRequest(wholesaleFormSchema), wholesaleFormSubmit);
router.get("/admin/:filter", verifyToken, requireAdmin, getAdminAddForms);
router.delete("/admin/:id", verifyToken, requireAdmin, deleteAddForm);

module.exports = router;
