const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { getAdminAuditLog } = require("../controllers/auditLog.controller");

router.get("/admin-audit-log", verifyToken, requireAdmin, getAdminAuditLog);

module.exports = router;
