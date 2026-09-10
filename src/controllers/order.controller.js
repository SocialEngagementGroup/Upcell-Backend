const mongoose = require("mongoose");
const { Resend } = require("resend");
const Order = require("../models/order.model");
const { toCustomerOrder, ownsOrder } = require("../utils/orderView");
const { salesTaxRate } = require("../services/salesTax");
const { validateShipment } = require("../services/returnShipping");
const AuditLog = require("../models/auditLog.model");
const { Notification } = require("../models/notification.model");
const { makeOrderObjAndTotal } = require("./checkout.controller");
const {
  orderStatusEmail,
  orderPlacedEmail,
  adminOrderStatusEmail,
  adminNewOrderEmail,
  refundApprovedEmail,
  orderShippedEmail,
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

// The rate the shop quotes, so the cart and the checkout stop carrying their
// own copy of it. Public and cacheable: it is the same number for everyone and
// it is printed on every receipt anyway.
function getTaxRate(req, res) {
  res.set("Cache-Control", "public, max-age=300");
  return res.status(200).json({ rate: salesTaxRate() });
}

async function getOrder(req, res, next) {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id || "")) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Anyone who is not the owner gets the same answer as a missing order.
    //
    // There used to be a third answer here: the document minus seven personal
    // fields, handed to any caller who knew the id. That still carried the
    // card brand and last four, the AVS result, the bank's transaction id, the
    // Clerk user id, the ship-to state, every device's IMEI, and the whole
    // refund block including which staff member keyed it in at the bank.
    //
    // A distinct "not yours" would also confirm that an id exists, which is
    // exactly what somebody walking the id range is trying to learn. One
    // answer for both.
    if (!ownsOrder(req.user, order)) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.status(200).json(toCustomerOrder(order));
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
        // Prefers the stored totalCents (see Backend/src/utils/orderItems.js)
        // over re-summing line_items — orders that predate it fall back to
        // the same live sum this pipeline always did. No $unwind/regroup
        // needed either way: Mongo's dot-notation through an array of
        // subdocuments already yields an array of totalPaid values, which
        // $sum totals directly.
        {
          $addFields: {
            orderTotal: {
              $cond: [
                { $ifNull: ["$totalCents", false] },
                { $divide: ["$totalCents", 100] },
                { $sum: "$line_items.price_data.product_data.metadata.totalPaid" },
              ],
            },
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
const DELIVERED_STATUS = "Delivered";

// Where each carrier's own tracking page lives.
//
// Built here rather than stored, so a carrier changing its URL is one edit and
// not a migration over every order ever shipped. "Other" gets no link: a
// guessed URL that 404s is worse than the number on its own, which a customer
// can paste anywhere.
const TRACKING_URLS = {
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  UPS: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  DHL: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(n)}`,
};

const trackingUrlFor = (carrier, trackingNumber) =>
  (TRACKING_URLS[carrier] ? TRACKING_URLS[carrier](trackingNumber) : null);

/**
 * Records that an order has shipped, and tells the customer.
 *
 * Staff buy the label by hand in the carrier's own tool and paste the number
 * back here — the same manual first phase the returns side runs on, and the
 * same validator, so the two cannot drift on what a tracking number looks
 * like.
 *
 * Moving to Shipped goes through the same statement that stamps shippedAt
 * everywhere else, because the return window counts from it when no delivery
 * is ever recorded.
 */
async function recordOrderShipment(req, res, next) {
  try {
    const { carrier, trackingNumber, labelUrl } = req.body || {};

    const order = await Order.findById(req.params.id || null);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (!order.paid) {
      // Shipping an unpaid order is either a mistake or a decision somebody
      // should make deliberately, on the order, not by pasting a number.
      return res.status(400).json({ error: "This order has not been paid for yet." });
    }

    const shipment = validateShipment({ carrier, trackingNumber, labelUrl });
    if (!shipment.ok) return res.status(400).json({ error: shipment.error });

    // One parcel, one order. Two orders sharing a number means a customer
    // tracking theirs sees somebody else's parcel, and a carrier update lands
    // on the wrong record.
    const clash = await Order.findOne({
      "fulfilment.trackingNumber": shipment.trackingNumber,
      _id: { $ne: order._id },
    })
      .select("_id")
      .lean();

    if (clash) {
      return res.status(409).json({
        error: "That tracking number is already on another order.",
        trackingNumberInUse: String(clash._id),
      });
    }

    const alreadyShipped = Boolean(order.fulfilment?.trackingNumber);

    order.fulfilment = {
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      labelUrl: shipment.labelUrl,
      shippedBy: req.user?.email || req.user?.id,
    };

    order.status = "Shipped";
    order.paid = true;
    // Stamped once, and left alone if this is a correction to the number.
    if (!order.shippedAt) order.shippedAt = new Date();

    await order.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: alreadyShipped ? "order.shipment_corrected" : "order.shipped",
      targetType: "Order",
      targetId: order._id,
      metadata: {
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
      },
    }).catch((error) => {
      console.error("[audit] order.shipped log failed:", error);
    });

    // Only on the first shipment. Correcting a typo should not send a second
    // "your order is on its way" to somebody who has already had one.
    if (!alreadyShipped && order.email) {
      const { subject, html } = orderShippedEmail({
        orderId: order._id,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: trackingUrlFor(shipment.carrier, shipment.trackingNumber),
        itemNames: (order.items || []).map((item) => item.name).filter(Boolean),
      });

      resend.emails
        .send({ from: orderEmailFrom, to: [order.email], subject, html })
        .catch((error) => console.error("[email] order shipped send failed:", error));
    }

    return res.status(200).json({
      ok: true,
      status: order.status,
      fulfilment: {
        carrier: order.fulfilment.carrier,
        trackingNumber: order.fulfilment.trackingNumber,
        trackingUrl: trackingUrlFor(shipment.carrier, shipment.trackingNumber),
      },
      emailed: !alreadyShipped,
    });
  } catch (error) {
    return next(error);
  }
}

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

    // Stamped the first time an order ships, and left alone after — for the
    // same reason deliveredAt is. It is the fallback the return window uses
    // when a delivery was never recorded.
    if (status === "Shipped" && !order.shippedAt) {
      order.shippedAt = new Date();
    }

    // Stamped the first time an order reaches Delivered, and left alone after.
    // The 30-day return window counts from this date, so a status set back to
    // Shipped and forward to Delivered again must not hand the customer a fresh
    // 30 days.
    if (status === DELIVERED_STATUS && !order.deliveredAt) {
      order.deliveredAt = new Date();
    }

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
  const { itemIds, reasonCode, waiveRestockingFee, waiveReason, notes } = req.body;

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
      // Refunding an order directly, with no return request behind it, so the
      // admin says why. Without a reason no restocking fee is charged, which is
      // the right way round: a fee taken by accident is not recoverable once
      // the money has gone, and a fee missed can still be applied by hand.
      reasonCode,
      waiveRestockingFee: Boolean(waiveRestockingFee),
      waiveReason,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const { refundableItems, itemsTotal, restockingFee, restockingFeeWaived, taxRefunded, refundAmount } =
      result;
    const refundedProductIds = refundableItems.map(
      (item) => item.price_data.product_data.metadata.productId
    );

    order.refund = {
      itemsTotal,
      restockingFee,
      restockingFeeWaived,
      waiveReason: restockingFeeWaived ? waiveReason : undefined,
      taxRefunded,
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
      metadata: {
        itemsTotal,
        restockingFee,
        restockingFeeWaived,
        taxRefunded,
        refundAmount,
        itemIds: refundedProductIds,
      },
    }).catch((error) => {
      console.error("[audit] order.refund_processed log failed:", error);
    });

    // The customer is told by email; without this the staff are not told at all.
    // Recording a refund moves no money — someone still has to type the figure
    // into the Business Center — so the one person who must not miss this is the
    // one who has to act. A forgotten entry leaves the customer holding an email
    // saying they were refunded and nothing in their account.
    //
    // Fire-and-forget like the audit log above: a notification that fails to
    // write must not undo a refund that is already recorded.
    Notification.create({
      type: "order",
      title: "Refund needs entering at the bank",
      message: `$${refundAmount.toFixed(2)} approved by ${req.user?.email || "an admin"}. It is not paid until it is entered in the Business Center.`,
      link: `/admin-secret/orders/${order._id}`,
      relatedId: order._id,
    }).catch((error) => {
      console.error("[order] refund notification failed:", error?.message || error);
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
        taxRefunded,
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

    // The same view the single-order route returns, so a customer cannot read
    // a field from the list that the detail page will not show them.
    res.json(orders.map(toCustomerOrder));
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

/**
 * Marks a recorded refund as actually entered in the Business Center.
 *
 * The gap this closes: processRefund calculates the figure, tells the customer
 * and sets the order to Refunded, but the money only moves when a person types
 * that figure into the bank's portal. Nothing recorded whether they had. "Has
 * this one been done?" could only be answered by asking around.
 *
 * Deliberately one-way. Unticking it would mean a refund that the bank has
 * already been told about looks outstanding again, which is the more dangerous
 * mistake of the two — it invites a second entry and a double refund.
 */
async function markRefundEnteredAtBank(req, res, next) {
  try {
    const order = await Order.findById(req.params.id || null);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!order.refund?.approvedAt) {
      return res.status(400).json({ error: "This order has no recorded refund." });
    }

    if (order.refund.enteredAtBankAt) {
      return res.status(400).json({ error: "This refund is already marked as entered at the bank." });
    }

    order.refund.enteredAtBankAt = new Date();
    order.refund.enteredAtBankBy = req.user?.email;
    await order.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "order.refund_entered_at_bank",
      targetType: "Order",
      targetId: order._id,
      metadata: { amount: order.refund.amount },
    }).catch((error) => {
      console.error("[audit] order.refund_entered_at_bank log failed:", error);
    });

    res.json({ refund: order.refund });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOrder,
  recordOrderShipment,
  trackingUrlFor,
  getTaxRate,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  processRefund,
  markRefundEnteredAtBank,
  getClientOrders,
  createOrder,
};
