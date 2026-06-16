const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { orderSchema } = require("../schemas/request.schemas");
const {
  getOrder,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  getClientOrders,
  createOrder,
} = require("../controllers/order.controller");

router.get("/order/:id", getOrder);
router.get("/admin-orders/:status", verifyToken, requireAdmin, getAdminOrders);
router.get("/admin-orders-by-data", verifyToken, requireAdmin, getAdminOrdersByDate);
router.post("/update-order-status", verifyToken, requireAdmin, updateOrderStatus);
router.get("/client-orders/:email", verifyToken, getClientOrders);
router.post("/orders", validateRequest(orderSchema), createOrder);

module.exports = router;
