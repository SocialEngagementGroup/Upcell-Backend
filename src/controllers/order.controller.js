const mongoose = require("mongoose");
const { Resend } = require("resend");
const Order = require("../models/order.model");
const AuditLog = require("../models/auditLog.model");
const { makeOrderObjAndTotal } = require("./checkout.controller");
const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../utils/pagination");

const resend = new Resend(process.env.RESEND_KEY);
const orderEmailFrom = process.env.EMAIL_FROM;

async function getOrder(req, res, next) {
  try {
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

    const [tDay, tWeek, tMonth] = await Promise.all([
      Order.find({ createdAt: { $gte: thisDay } }),
      Order.find({ createdAt: { $gte: thisWeekStart } }),
      Order.find({ createdAt: { $gte: monthStart, $lt: monthEnd } }),
    ]);

    res.status(200).json({ today: tDay, thisWeek: tWeek, thisMonth: tMonth });
  } catch (error) {
    next(error);
  }
}

async function updateOrderStatus(req, res, next) {
  const { orderId, status } = req.body;

  try {
    const order = await Order.findById(orderId);
    const previousStatus = order.status;
    order.status = status;

    await order.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "order.status_update",
      targetType: "Order",
      targetId: order._id,
      metadata: { from: previousStatus, to: status },
    }).catch((error) => {
      console.error("[audit] order.status_update log failed:", error);
    });

    const clientEmail = order?.email;

    await resend.emails.send({
      from: orderEmailFrom,
      to: [clientEmail],
      subject: `Order status changed to ${status}`,
      html: `<strong>Your order status updated!</strong> </br> <p> Your order with Order_Id:  <span style="color:blue">${order._id}</span>, status updated to <strong> ${status} </strong> </p> </br> <small> Thank you for staying with UpCell IT </small>`,
    });

    res.send("success");
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

    const orders = await Order.find({ email, paid: true }).sort({
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
    order.paid = true;
    order.status = "Processing";

    const newOrder = await Order.create(order);
    res.status(201).json(newOrder);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOrder,
  getAdminOrders,
  getAdminOrdersByDate,
  updateOrderStatus,
  getClientOrders,
  createOrder,
};
