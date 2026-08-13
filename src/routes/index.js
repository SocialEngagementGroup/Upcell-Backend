const router = require("express").Router();

const categoryRoutes = require("./category.routes");
const productRoutes = require("./product.routes");
const cartRoutes = require("./cart.routes");
const orderRoutes = require("./order.routes");
const tradeInRoutes = require("./tradeIn.routes");
const newsletterRoutes = require("./newsletter.routes");
const contactRoutes = require("./contact.routes");
const analyticsRoutes = require("./analytics.routes");
const stripeRoutes = require("./stripe.routes");
const checkoutCustomerRoutes = require("./checkoutCustomer.routes");
const wholesaleRoutes = require("./wholesale.routes");
const monthlySellRoutes = require("./monthlySell.routes");
const emailConfigRoutes = require("./emailConfig.routes");
const notificationRoutes = require("./notification.routes");
const auditLogRoutes = require("./auditLog.routes");
const uploadRoutes = require("./upload.routes");

router.use("/", categoryRoutes);
router.use("/", productRoutes);
router.use("/", cartRoutes);
router.use("/", orderRoutes);
router.use("/", tradeInRoutes);
router.use("/", newsletterRoutes);
router.use("/", contactRoutes);
router.use("/", analyticsRoutes);
// Disabled per client decision 2026-08-06 — bank gateway replaces these.
// Kept as backup: controllers/routes are untouched, only unmounted here.
// router.use("/", stripeRoutes);
// router.use("/checkout-customer", checkoutCustomerRoutes);
router.use("/add-run-form-submit", wholesaleRoutes);
router.use("/this-month-sold-items", monthlySellRoutes);
router.use("/", emailConfigRoutes);
router.use("/", notificationRoutes);
router.use("/", auditLogRoutes);
router.use("/", uploadRoutes);

module.exports = router;
