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

router.use("/", categoryRoutes);
router.use("/", productRoutes);
router.use("/", cartRoutes);
router.use("/", orderRoutes);
router.use("/", tradeInRoutes);
router.use("/", newsletterRoutes);
router.use("/", contactRoutes);
router.use("/", analyticsRoutes);
router.use("/", stripeRoutes);
router.use("/checkout-customer", checkoutCustomerRoutes);
router.use("/add-run-form-submit", wholesaleRoutes);
router.use("/this-month-sold-items", monthlySellRoutes);
router.use("/", emailConfigRoutes);
router.use("/", notificationRoutes);

module.exports = router;
