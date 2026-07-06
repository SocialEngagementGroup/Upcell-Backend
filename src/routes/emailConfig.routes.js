const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { getEmailConfig, updateEmailConfig } = require("../controllers/emailConfig.controller");

router.get("/admin-email-config", verifyToken, requireAdmin, getEmailConfig);
router.patch("/admin-email-config", verifyToken, requireAdmin, updateEmailConfig);

module.exports = router;
