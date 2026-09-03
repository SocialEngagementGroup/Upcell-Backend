const PaymentEventLog = require("../models/paymentEventLog.model");
const Order = require("../models/order.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");

// Everything payment-related that happened, readable from the admin panel.
// Until now this table could only be read by opening the database by hand,
// which meant that in practice nobody read it — the confirmations that went
// missing were sitting in here the whole time.

const EVENT_TYPES = [
  "webhook_received",
  "marked_paid",
  "signature_rejected",
  "unmatched_confirmation",
  "amount_mismatch",
  "duplicate_confirmation",
  "config_error",
  "refunded",
];

// Which events mean someone needs to do something. Drives the colour of the
// row in the admin table, so the list can be scanned rather than read.
const SEVERITY = {
  unmatched_confirmation: "critical",
  amount_mismatch: "critical",
  config_error: "critical",
  signature_rejected: "warning",
  duplicate_confirmation: "info",
  webhook_received: "info",
  marked_paid: "good",
  refunded: "info",
};

async function getPaymentEvents(req, res, next) {
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    const query = {};

    const { type, gateway, orderId } = req.query;
    if (type && EVENT_TYPES.includes(type)) query.eventType = type;
    if (gateway) query.gateway = gateway;
    if (orderId && /^[0-9a-fA-F]{24}$/.test(orderId)) query.orderId = orderId;

    // "Problems only" — the default view an admin actually wants, rather than
    // scrolling past hundreds of routine confirmations to find the one failure.
    if (req.query.problemsOnly === "true") {
      query.eventType = {
        $in: ["unmatched_confirmation", "amount_mismatch", "signature_rejected", "config_error"],
      };
    }

    return sendPaginatedResults({
      res,
      model: PaymentEventLog,
      query,
      sort: { createdAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

// Counts for the dashboard tiles. Cheap enough to compute per request — this
// is an admin screen with a handful of viewers, not a public endpoint.
async function getPaymentSummary(req, res, next) {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [byType, paidCount, pendingCount, reviewCount, failedCount, unpaidValue] = await Promise.all([
      PaymentEventLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$eventType", count: { $sum: 1 } } },
      ]),
      Order.countDocuments({ paidWith: "BankOfAmerica", paid: true, createdAt: { $gte: since } }),
      Order.countDocuments({ paidWith: "BankOfAmerica", status: "pending_payment", createdAt: { $gte: since } }),
      // Counted separately from pending: these are payments a person at the
      // bank is checking, and they hold their devices off sale while they wait.
      // Folded into "pending" they would be indistinguishable from abandoned
      // carts, which is the one thing they must not be mistaken for.
      Order.countDocuments({ paidWith: "BankOfAmerica", status: "under_review", createdAt: { $gte: since } }),
      Order.countDocuments({ paidWith: "BankOfAmerica", status: "payment failed", createdAt: { $gte: since } }),
      Order.aggregate([
        { $match: { paidWith: "BankOfAmerica", paid: true, createdAt: { $gte: since } } },
        { $unwind: "$line_items" },
        { $group: { _id: null, total: { $sum: "$line_items.price_data.product_data.metadata.totalPaid" } } },
      ]),
    ]);

    const events = Object.fromEntries(byType.map((row) => [row._id, row.count]));
    const problems =
      (events.unmatched_confirmation || 0) +
      (events.amount_mismatch || 0) +
      (events.signature_rejected || 0) +
      (events.config_error || 0);

    res.json({
      windowDays: 7,
      orders: { paid: paidCount, pending: pendingCount, review: reviewCount, failed: failedCount },
      takings: Number((unpaidValue[0]?.total || 0).toFixed(2)),
      events,
      problems,
      severity: SEVERITY,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getPaymentEvents, getPaymentSummary, SEVERITY, EVENT_TYPES };
