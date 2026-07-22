const mongoose = require("mongoose");
const { TradeInRequest, tradeInStatusEnum } = require("../models/tradeInRequest.model");
const { EmailConfig } = require("../models/emailConfig.model");
const { Notification } = require("../models/notification.model");
const AuditLog = require("../models/auditLog.model");
const { sendMail, getMessageId } = require("../services/mailService");
const { tradeInRequestEmail, tradeInStatusEmail } = require("../services/emailTemplates");
const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../utils/pagination");

const tradeInEmailFrom = process.env.EMAIL_FROM;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

// Statuses that should notify the customer at all — "Closed" (a rejected/
// withdrawn request) intentionally has no customer-facing copy, same as
// before this template swap.
const CUSTOMER_NOTIFIABLE_STATUSES = new Set(["New", "Contacted", "Received", "Quoted", "Paid"]);

function buildCustomerEmail(request) {
  if (!CUSTOMER_NOTIFIABLE_STATUSES.has(request.status)) {
    return null;
  }
  if (request.status === "New") {
    return tradeInRequestEmail({
      name: request.name,
      modelTitle: request.modelTitle,
      estimate: request.estimate,
      requestId: request._id,
    });
  }
  return tradeInStatusEmail({
    name: request.name,
    status: request.status,
    estimate: request.estimate,
    requestId: request._id,
  });
}

function tradeInEmailSubject(request) {
  const modelTitle = String(request.modelTitle ?? "").replace(/[\r\n]/g, " ");
  return `Your UpCell trade-in request — ${modelTitle} (#${String(request._id).slice(-6)})`;
}

async function fetchEmailConfig() {
  let config = await EmailConfig.findOne();
  if (!config) {
    config = await EmailConfig.create({});
  }
  return config;
}

async function sendCustomerStatusEmail(request, config) {
  const built = buildCustomerEmail(request);
  if (!config.enableCustomerEmails || !built) {
    await TradeInRequest.findByIdAndUpdate(request._id, { emailStatus: "skipped" });
    return;
  }

  const isThreadStarter = !request.emailThreadId;
  // Deliberately NOT using built.subject here — tradeInEmailSubject stays
  // fixed across every status update so replies keep threading correctly
  // in the customer's inbox. Only the HTML design comes from the new template.
  const baseSubject = tradeInEmailSubject(request);

  const result = await sendMail({
    from: tradeInEmailFrom,
    to: request.email,
    subject: isThreadStarter ? baseSubject : `Re: ${baseSubject}`,
    html: built.html,
    headers: isThreadStarter
      ? undefined
      : { "In-Reply-To": request.emailThreadId, "References": request.emailThreadId },
  });

  const update = { emailStatus: result.sent ? "sent" : "failed" };

  if (result.sent && isThreadStarter && result.id) {
    const realMessageId = await getMessageId(result.id);
    if (realMessageId) {
      update.emailThreadId = realMessageId;
    }
  }

  await TradeInRequest.findByIdAndUpdate(request._id, update);

  if (result.sent) {
    await EmailConfig.updateOne({ _id: config._id }, { $inc: { sentCount: 1 } });
  }
}

async function sendAdminNewRequestEmail(request, config) {
  if (!config.enableAdminEmails || !config.tradeInAdminEmail) return;

  const result = await sendMail({
    from: tradeInEmailFrom,
    to: config.tradeInAdminEmail,
    subject: "New trade-in request received",
    html: `<strong>New trade-in request</strong></br>
      <p>Device: ${escapeHtml(request.modelTitle)} (${escapeHtml(request.storage)})</p></br>
      <p>Estimate: $${request.estimate}</p></br>
      <p>Customer: ${escapeHtml(request.name)} — ${escapeHtml(request.email)} — ${escapeHtml(request.phone)}</p></br>
      <p>Request ID: ${request._id}</p>`,
  });

  if (result.sent) {
    await EmailConfig.updateOne({ _id: config._id }, { $inc: { sentCount: 1 } });
  }
}

async function notifyNewTradeIn(request) {
  const config = await fetchEmailConfig();

  await Promise.all([
    sendCustomerStatusEmail(request, config),
    sendAdminNewRequestEmail(request, config),
  ]);

  await Notification.create({
    type: "trade-in",
    title: "New trade-in request",
    message: `${request.name} submitted a trade-in request for ${request.modelTitle} ($${request.estimate})`,
    link: `/admin-secret/trade-in/${request._id}`,
    relatedId: request._id,
  });
}

async function notifyTradeInStatusChange(request) {
  const config = await fetchEmailConfig();

  await sendCustomerStatusEmail(request, config);

  await Notification.create({
    type: "trade-in",
    title: `Trade-in status: ${request.status}`,
    message: `Request ${request._id} for ${request.name} moved to "${request.status}"`,
    link: `/admin-secret/trade-in/${request._id}`,
    relatedId: request._id,
  });
}

async function createTradeInRequest(req, res, next) {
  try {
    const request = await TradeInRequest.create(req.body);
    res.status(201).json(request);

    notifyNewTradeIn(request).catch((error) => {
      console.error("[tradeIn] new-request notification failed:", error);
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminTradeInRequests(req, res, next) {
  const status = req.params.status;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (status.startsWith("byEmail:")) {
      const email = status.replace("byEmail:", "");
      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { email },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (status.startsWith("byRequestId:")) {
      const id = status.replace("byRequestId:", "");
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return emptyPaginatedResponse({ res, page, limit });
      }

      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { _id: id },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (tradeInStatusEnum.includes(status)) {
      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { status },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: TradeInRequest,
      query: {},
      sort: { updatedAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

async function updateTradeInStatus(req, res, next) {
  const { status } = req.body;

  try {
    if (!tradeInStatusEnum.includes(status)) {
      return res.status(400).json({ error: "Invalid trade-in status" });
    }

    const previous = await TradeInRequest.findById(req.params.id);
    if (!previous) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }
    const previousStatus = previous.status;

    const updated = await TradeInRequest.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    res.status(200).json(updated);

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.status_update",
      targetType: "TradeInRequest",
      targetId: updated._id,
      metadata: { from: previousStatus, to: status },
    }).catch((error) => {
      console.error("[audit] trade_in.status_update log failed:", error);
    });

    notifyTradeInStatusChange(updated).catch((error) => {
      console.error("[tradeIn] status-change notification failed:", error);
    });
  } catch (error) {
    next(error);
  }
}

async function deleteTradeInRequest(req, res, next) {
  try {
    const deleted = await TradeInRequest.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }

    res.status(200).json(deleted);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  deleteTradeInRequest,
};
