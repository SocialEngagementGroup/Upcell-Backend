const mongoose = require("mongoose");
const TradeInPriceBook = require("../models/tradeInPriceBook.model");
const TradeInQuestion = require("../models/tradeInQuestion.model");
const { quote, toDollars } = require("../services/tradeInPricing");
const { TradeInRequest, tradeInStatusEnum } = require("../models/tradeInRequest.model");
const { EmailConfig } = require("../models/emailConfig.model");
const { Notification } = require("../models/notification.model");
const AuditLog = require("../models/auditLog.model");
const { sendMail, getMessageId } = require("../services/mailService");
const {
  tradeInRequestEmail,
  tradeInStatusEmail,
  shouldEmailStatus,
  adminNewTradeInEmail,
  adminTradeInStatusEmail,
} = require("../services/emailTemplates");
const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../utils/pagination");
const tradeInStatus = require("../constants/tradeInStatus");
const { isTradeInStatus } = tradeInStatus;
const { applyTransition } = require("../services/returnTimeline");

const tradeInEmailFrom = process.env.EMAIL_FROM;

/**
 * The email for one status change, or null when this one is not worth
 * sending.
 *
 * Which states are worth interrupting somebody for lives in emailTemplates.js
 * next to the words themselves — InTransit and Delivered are deliberately
 * silent, because a customer who posted a phone knows they posted it and the
 * carrier is already emailing them about it.
 *
 * firstContact rather than a status check for the welcome email. The default
 * status used to be "New" and is now "Quoted", and keying the first email on
 * a status value is how a rename silently stops it being sent.
 */
function buildCustomerEmail(request, { firstContact = false } = {}) {
  if (firstContact) {
    return tradeInRequestEmail({
      name: request.name,
      modelTitle: request.modelTitle,
      estimate: request.estimate,
      requestId: request._id,
    });
  }

  if (!shouldEmailStatus(request.status)) return null;

  return tradeInStatusEmail({
    name: request.name,
    modelTitle: request.modelTitle,
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

async function sendCustomerStatusEmail(request, config, options = {}) {
  const built = buildCustomerEmail(request, options);
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

  const { subject, html } = adminNewTradeInEmail({
    name: request.name,
    email: request.email,
    phone: request.phone,
    modelTitle: request.modelTitle,
    storage: request.storage,
    estimate: request.estimate,
    requestId: request._id,
  });

  const result = await sendMail({
    from: tradeInEmailFrom,
    to: config.tradeInAdminEmail,
    subject,
    html,
  });

  if (result.sent) {
    await EmailConfig.updateOne({ _id: config._id }, { $inc: { sentCount: 1 } });
  }
}

async function notifyNewTradeIn(request) {
  const config = await fetchEmailConfig();

  await Promise.all([
    sendCustomerStatusEmail(request, config, { firstContact: true }),
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

async function sendAdminStatusChangeEmail(request, config) {
  if (!config.enableAdminEmails || !config.tradeInAdminEmail) return;

  const { subject, html } = adminTradeInStatusEmail({
    name: request.name,
    email: request.email,
    phone: request.phone,
    modelTitle: request.modelTitle,
    storage: request.storage,
    status: request.status,
    estimate: request.estimate,
    requestId: request._id,
  });

  const result = await sendMail({
    from: tradeInEmailFrom,
    to: config.tradeInAdminEmail,
    subject,
    html,
  });

  if (result.sent) {
    await EmailConfig.updateOne({ _id: config._id }, { $inc: { sentCount: 1 } });
  }
}

async function notifyTradeInStatusChange(request) {
  const config = await fetchEmailConfig();

  await Promise.all([
    sendCustomerStatusEmail(request, config),
    sendAdminStatusChangeEmail(request, config),
  ]);

  await Notification.create({
    type: "trade-in",
    title: `Trade-in status: ${request.status}`,
    message: `Request ${request._id} for ${request.name} moved to "${request.status}"`,
    link: `/admin-secret/trade-in/${request._id}`,
    relatedId: request._id,
  });
}

// Fourteen days, matching the quote the customer was shown.
const QUOTE_DAYS = 14;

async function createTradeInRequest(req, res, next) {
  try {
    const { estimate: clientEstimate, ...submitted } = req.body || {};

    // The client's number is read for the record and never for the price.
    //
    // This endpoint used to store whatever arrived. Posting `estimate: 9999`
    // put nine thousand dollars in front of staff as an offer to honour, and
    // nothing anywhere would have contradicted it.
    const priceBook = await TradeInPriceBook.findOne({
      modelKey: submitted.model,
      active: true,
    }).lean();

    if (!priceBook) {
      return res.status(400).json({
        error: "We are not quoting for that model at the moment.",
      });
    }

    const set = await TradeInQuestion.findOne({ deviceType: priceBook.deviceType }).lean();

    const priced = quote({
      priceBook,
      questions: set?.questions || [],
      storage: submitted.storage,
      carrier: submitted.carrier,
      answers: submitted.answers || {},
    });

    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const request = await TradeInRequest.create({
      ...submitted,
      estimate: toDollars(priced.estimateCents),
      estimateCents: priced.estimateCents,
      clientEstimateCents: Number.isFinite(Number(clientEstimate))
        ? Math.round(Number(clientEstimate) * 100)
        : undefined,
      quoteBreakdown: priced.breakdown,
      priceBookVersion: priced.priceBookVersion,
      quoteExpiresAt: new Date(Date.now() + QUOTE_DAYS * 24 * 60 * 60 * 1000),
    });

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
  const { status, note } = req.body;

  try {
    if (!isTradeInStatus(status)) {
      return res.status(400).json({ error: "Invalid trade-in status" });
    }

    const request = await TradeInRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }
    const previousStatus = request.status;

    // Through the state machine, not findByIdAndUpdate. A direct write skips
    // the transition map, and an illegal state reached once stays reached —
    // there is nothing later that puts it back. It is also what writes the
    // timeline entry, which is the dispute record.
    const moved = applyTransition(request, status, {
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      machine: tradeInStatus,
      meta: note ? { note: String(note).slice(0, 500) } : undefined,
    });

    if (!moved.ok) {
      return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    }

    await request.save();
    const updated = request;

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
