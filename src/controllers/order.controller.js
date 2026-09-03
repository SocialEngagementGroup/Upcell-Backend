const mongoose = require("mongoose");
const { Resend } = require("resend");
const Order = require("../models/order.model");
const AuditLog = require("../models/auditLog.model");
const { makeOrderObjAndTotal } = require("./checkout.controller");
const {
  orderStatusEmail,
  orderPlacedEmail,
  adminOrderStatusEmail,
  adminNewOrderEmail,
  refundApprovedEmail,
} = require("../services/emailTemplates");
const { calculateRefund } = require("../services/refund");
const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../utils/pagination");

const resend = new Resend(process.env.RESEND_KEY);
const orderEmailFrom = process.env.EMAIL_FROM;
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;

// Mongo ObjectId as it appears in a URL. Checking the shape before querying
// keeps a malformed id (a "/order/undefined" from a page loaded without its
// query string, a crawler, a probe) a plain 404 instead of a CastError — which
// the global handler would turn into a 500 and page the admin over.
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

async function getOrder(req, res, next) {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id || "")) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const isOwner = req.user?.role === "admin" || req.user?.email === order.email;
    if (isOwner) {
      return res.status(200).json(order);
    }

    const { name, email, phone, city, postal, street, country, ...safeOrder } =
      order.toObject();
    res.status(200).json(safeOrder);
  } catch (error) {
    next(error);
  }
}

async function getAdminOrders(req, res, next) {
  const status = req.params.status;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (status.startsWith("byEmail") || status.startsWith("byOrderId")) {
      const [method, value] = status.split(":");
      if (method === "byEmail") {
        return sendPaginatedResults({
          res,
          model: Order,
          query: { email: value },
          sort: { updatedAt: -1 },
          page,
          limit,
          skip,
        });
      }

      if (!value || !mongoose.Types.ObjectId.isValid(value)) {
        return emptyPaginatedResponse({ res, page, limit });
      }

      return sendPaginatedResults({
        res,
        model: Order,
        query: { _id: value },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: Order,
      query: { status },
      sort: { updatedAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminOrdersByDate(req, res, next) {
  try {
    const now = new Date();

    const thisDay = new Date(now);
    thisDay.setHours(0, 0, 0, 0);

    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    thisWeekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Only paid orders count. A checkout someone started and abandoned is not
    // a sale, and counting one would overstate both order volume and revenue.
    //
    // The filtering used to happen in the browser, which meant every abandoned
    // checkout was sent over the wire first — name, email, phone and full
    // address for orders that were then discarded on arrival. Counting in the
    // database sends numbers instead of customer records, and makes the rule
    // part of the data rather than part of one page's rendering code.
    const summarise = async (range) => {
      const [result] = await Order.aggregate([
        { $match: { paid: true, createdAt: range } },
        { $unwind: "$line_items" },
        {
          $group: {
            _id: "$_id",
            orderTotal: { $sum: "$line_items.price_data.product_data.metadata.totalPaid" },
          },
        },
        { $group: { _id: null, amount: { $sum: 1 }, money: { $sum: "$orderTotal" } } },
      ]);

      return {
        amount: result?.amount || 0,
        money: Number((result?.money || 0).toFixed(2)),
      };
    };

    const [today, thisWeek, thisMonth] = await Promise.all([
      summarise({ $gte: thisDay }),
      summarise({ $gte: thisWeekStart }),
      summarise({ $gte: monthStart, $lt: monthEnd }),
    ]);

    res.status(200).json({ today, thisWeek, thisMonth });
  } catch (error) {
    next(error);
  }
}

const ORDER_STATUS_VALUES = ["pending_payment", "under_review", "Processing", "Shipped", "Delivered", "Returned", "Refunded", "payment failed"];

// Statuses that mean no money has been received. Everything else implies a
// confirmed payment — including Returned and Refunded, where the payment did
// happen and was reversed afterwards, so those orders must stay visible to the
// customer rather than dropping off their order list.
//
// under_review belongs here: the bank has not settled it, so treating it as
// paid would put revenue on the dashboard that may never arrive.
const UNPAID_STATUSES = ["pending_payment", "under_review", "payment failed"];

async function updateOrderStatus(req, res, next) {
  const { orderId, status } = req.body;

  try {
    if (!ORDER_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: "Invalid order status" });
    }

    const order = await Order.findById(orderId || null);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const previousStatus = order.status;
    const previousPaid = order.paid;
    order.status = status;

    // This is the only path that can confirm a payment now: the bank-hosted
    // gateway settles out-of-band and capturePayment's route is unmounted
    // (see routes/index.js), so createOrder always writes pending_payment.
    // Keeping `paid` in step with status here is what puts the order on the
    // customer's own order list, which filters on paid:true in
    // getClientOrders below.
    order.paid = !UNPAID_STATUSES.includes(status);

    await order.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "order.status_update",
      targetType: "Order",
      targetId: order._id,
      metadata: { from: previousStatus, to: status, paidFrom: previousPaid, paidTo: order.paid },
    }).catch((error) => {
      console.error("[audit] order.status_update log failed:", error);
    });

    const clientEmail = order?.email;
    const { subject, html } = orderStatusEmail({ orderId: order._id, status });

    await resend.emails.send({
      from: orderEmailFrom,
      to: [clientEmail],
      subject,
      html,
    });

    if (adminNotificationEmail) {
      const { subject, html } = adminOrderStatusEmail({
        orderId: order._id,
        status,
        name: order.name,
        email: clientEmail,
      });

      resend.emails
        .send({ from: orderEmailFrom, to: [adminNotificationEmail], subject, html })
        .catch((error) => {
          console.error("[order] admin status-update notification failed:", error);
        });
    }

    res.send("success");
  } catch (error) {
    next(error);
  }
}

/**
 * Record a refund and email the customer. This never contacts the bank —
 * UpCell has no refund API credentials, so Raymond or Yasir still enter the
 * exact figure into the Business Center by hand. What this does is the part
 * that was entirely manual before: calculating the right number under the
 * client's own 15% restocking-fee rule, keeping a record of who approved it
 * and why a fee was or was not waived, and telling the customer.
 */
async function processRefund(req, res, next) {
  const { itemIds, waiveRestockingFee, waiveReason, notes } = req.body;

  try {
    const order = await Order.findById(req.params.id || null);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!order.paid) {
      return res.status(400).json({ error: "This order has not been paid, so there is nothing to refund." });
    }

    if (order.refund?.approvedAt) {
      return res.status(400).json({ error: "This order has already been refunded." });
    }

    const result = calculateRefund(order, {
      itemIds,
      waiveRestockingFee: Boolean(waiveRestockingFee),
      waiveReason,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const { refundableItems, itemsTotal, restockingFee, restockingFeeWaived, refundAmount } = result;
    const refundedProductIds = refundableItems.map(
      (item) => item.price_data.product_data.metadata.productId
    );

    order.refund = {
      itemsTotal,
      restockingFee,
      restockingFeeWaived,
      waiveReason: restockingFeeWaived ? waiveReason : undefined,
      amount: refundAmount,
      itemIds: refundedProductIds,
      notes,
      approvedBy: req.user?.email,
      approvedAt: new Date(),
    };
    // Refunded stays paid:true — the charge did happen. This is a record of
    // it being reversed, not proof that it was never real, and a customer
    // must still be able to find the order in their own account afterward.
    order.status = "Refunded";
    await order.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "order.refund_processed",
      targetType: "Order",
      targetId: order._id,
      metadata: { itemsTotal, restockingFee, restockingFeeWaived, refundAmount, itemIds: refundedProductIds },
    }).catch((error) => {
      console.error("[audit] order.refund_processed log failed:", error);
    });

    // Fire-and-forget, matching sendPaymentReceiptEmail elsewhere — a slow or
    // failed send must not undo a refund that has already been recorded and
    // is waiting on a human to enter it at the bank.
    if (order.email) {
      const itemNames = refundableItems.map((item) => item.price_data.product_data.name);
      const { subject, html } = refundApprovedEmail({
        orderId: order._id,
        itemNames,
        itemsTotal,
        restockingFee,
        refundAmount,
      });
      resend.emails
        .send({ from: orderEmailFrom, to: [order.email], subject, html })
        .catch((error) => {
          console.error("[order] refund email failed:", error);
        });
    }

    res.json({
      refund: order.refund,
      // Said once, plainly, in the response the admin UI reads directly —
      // this is the number that goes in the Business Center, not a
      // confirmation that money already moved.
      message: `Refund of $${refundAmount.toFixed(2)} recorded. Enter this exact amount in the Bank of America Business Center to complete it.`,
    });
  } catch (error) {
    next(error);
  }
}

async function getClientOrders(req, res, next) {
  const email = req.params.email;

  try {
    if (req.user?.role !== "admin" && req.user?.email !== email) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Match on the Clerk user id first, falling back to the email. Email alone
    // was the only link before userId existed, so the fallback keeps historical
    // orders visible; the userId arm is what makes an order findable when the
    // customer typed a different address into the checkout form than the one
    // on their account.
    const ownership = [{ email }];
    if (req.user?.id) ownership.push({ userId: req.user.id });

    const orders = await Order.find({ $or: ownership, paid: true }).sort({
      updatedAt: -1,
    });
    res.json(orders);
  } catch (error) {
    next(error);
  }
}

async function createOrder(req, res, next) {
  try {
    const paidWith = req.body.paidWith || "Card";
    const { order } = await makeOrderObjAndTotal({ req, paidWith });

    // No paidWith value auto-marks paid/Processing here — the bank-hosted
    // gateway confirms payment out-of-band after this request completes,
    // so paid stays false and status stays makeOrderObjAndTotal's
    // "pending_payment" default until that confirmation happens.
    const newOrder = await Order.create(order);
    res.status(201).json(newOrder);

    notifyOrderPlaced(newOrder).catch((error) => {
      console.error("[order] order-placed notification failed:", error);
    });
  } catch (error) {
    next(error);
  }
}

// Fire-and-forget, mirroring the pattern used for trade-in/payment-receipt
// notifications elsewhere — an email failure shouldn't fail order creation,
// which already responded to the customer above.
async function notifyOrderPlaced(order) {
  const sends = [];

  if (order.email) {
    const { subject, html } = orderPlacedEmail({ orderId: order._id, name: order.name });
    sends.push(resend.emails.send({ from: orderEmailFrom, to: [order.email], subject, html }));
  }

  if (adminNotificationEmail) {
    const { subject, html } = adminNewOrderEmail({
      orderId: order._id,
      paidWith: order.paidWith,
      name: order.name,
      email: order.email,
    });
    sends.push(resend.emails.send({ from: orderEmailFrom, to: [adminNotificationEmail], subject, html }));
  }

  await Promise.all(sends);
}

module.exports = {
  getOrder,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  processRefund,
  getClientOrders,
  createOrder,
};
