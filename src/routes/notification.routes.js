const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateObjectIdParam } = require("../middleware/validateObjectId.middleware");
const {
  getAdminNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
} = require("../controllers/notification.controller");

router.get("/admin-notifications", verifyToken, requireAdmin, getAdminNotifications);
router.get(
  "/admin-notifications-unread-count",
  verifyToken,
  requireAdmin,
  getUnreadNotificationCount
);
router.patch(
  "/admin-notifications/:id/read",
  verifyToken,
  requireAdmin,
  validateObjectIdParam(),
  markNotificationRead
);

module.exports = router;
