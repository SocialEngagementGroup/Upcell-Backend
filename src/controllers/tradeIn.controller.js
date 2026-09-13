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
const { applyTransition, recordEvent } = require("../services/returnTimeline");
const { maskReference } = require("../services/payoutSafety");
const {
  buildTradeInMetrics,
  groupTradeIns,
  toCsv,
} = require("../services/tradeInReporting");

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

/**
 * PATCH /admin-trade-in-requests/:id/payout
 *
 * Records that the money went out, and moves the request to Paid.
 *
 * Recording the payment and marking it paid are one action on purpose. Two
 * endpoints would let a request sit at Paid with no record of how, which is
 * the state somebody has to reconstruct from a bank statement months later
 * when a customer says they were never paid.
 */
async function recordTradeInPayout(req, res, next) {
  try {
    const { method, recipientName, referenceMasked, reference, note } = req.body;

    const request = await TradeInRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }

    if (request.payout?.paidAt) {
      return res.status(400).json({
        error: `This trade-in was already paid on ${new Date(request.payout.paidAt).toDateString()}.`,
      });
    }

    // The state machine decides whether paying is legal at all. A request
    // still in inspection has no agreed amount to pay.
    const moved = applyTransition(request, "Paid", {
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      event: "payout_recorded",
      machine: tradeInStatus,
      meta: { method, amountCents: amountOwed(request) },
    });

    if (!moved.ok) {
      return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    }

    request.payout = {
      method,
      recipientName,
      // Masked again here. Masking done in a browser is masking anybody can
      // turn off, and this is the copy that is kept.
      referenceMasked: maskReference(referenceMasked, method),
      amountCents: amountOwed(request),
      paidAt: new Date(),
      paidBy: req.user?.email,
      reference: reference || undefined,
    };

    if (note) {
      recordEvent(request, {
        event: "payout_note",
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        meta: { note: String(note).slice(0, 500) },
      });
    }

    await request.save();

    res.status(200).json(request);

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.payout_recorded",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: {
        method,
        amountCents: request.payout.amountCents,
        // The masked reference, never the full one — an audit log is read by
        // more people than the record it describes.
        referenceMasked: request.payout.referenceMasked,
      },
    }).catch((error) => {
      console.error("[audit] trade_in.payout_recorded log failed:", error);
    });

    notifyTradeInStatusChange(request).catch((error) => {
      console.error("[tradeIn] payout notification failed:", error);
    });
  } catch (error) {
    next(error);
  }
}

/**
 * What is owed, in cents.
 *
 * The revised offer where one was made and accepted, the original quote
 * otherwise. Read from the record rather than recalculated: a quote disputed
 * in November is answered from what was agreed, not by rerunning today's
 * prices over it.
 */
function amountOwed(request) {
  if (Number.isFinite(request?.revisedOfferCents)) return request.revisedOfferCents;
  if (Number.isFinite(request?.estimateCents)) return request.estimateCents;
  if (Number.isFinite(request?.estimate)) return Math.round(request.estimate * 100);
  return 0;
}


/**
 * GET /trade-ins/mine
 *
 * A customer's own trade-ins.
 *
 * Matched on the email address, because that is the only thing a trade-in
 * records about who submitted it — there is no Clerk id on the model. That
 * makes the verified check load-bearing rather than a formality: an
 * unverified address is one somebody typed, and matching on it would hand a
 * stranger the trade-in history of anybody whose email they know.
 *
 * Case-insensitive through a collation rather than a regex. A regex built from
 * an address is an injection, and the address here comes from Clerk rather
 * than from a form — but the next person to copy this line will not know that.
 */
async function getMyTradeIns(req, res, next) {
  try {
    if (!req.user?.emailVerified) {
      return res.status(403).json({
        error: "Confirm your email address and your trade-ins will appear here.",
      });
    }

    const email = String(req.user.email || "").trim();
    if (!email) return res.status(200).json({ items: [] });

    const items = await TradeInRequest.find({ email })
      .collation({ locale: "en", strength: 2 })
      .sort({ createdAt: -1 })
      .limit(50)
      // An allowlist. The inspector's id, the audit trail and the access token
      // are UpCell's business, not the customer's — and the token is the one
      // field that would let somebody answer an offer they should not see.
      .select("modelTitle storage status estimate estimateCents revisedOfferCents offerExpiresAt createdAt updatedAt payout.method payout.paidAt payout.amountCents inspection.finalGrade inspection.batteryHealth shipping.inbound.carrier shipping.inbound.trackingNumber shipping.inbound.labelUrl")
      .lean();

    return res.status(200).json({ items });
  } catch (error) {
    return next(error);
  }
}


// The window a report covers. Ninety days back by default, which is long
// enough for a wrong price to show up as a pattern rather than as noise.
function reportWindow(query = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

  return { from, to };
}

/**
 * GET /admin-trade-in-report
 * GET /admin-trade-in-report.csv
 *
 * What the trade-in data says. The mirror of the returns report: that one
 * asks which model keeps coming back, this one asks which model UpCell keeps
 * quoting too high for.
 */
async function getTradeInReport(req, res, next) {
  try {
    const { from, to } = reportWindow(req.query);

    const requests = await TradeInRequest.find({ createdAt: { $gte: from, $lte: to } })
      .select("status modelTitle model device storage estimate estimateCents revisedOfferCents payout createdAt timeline")
      .lean();

    const metrics = buildTradeInMetrics({ requests });
    const byModel = groupTradeIns(requests, "modelTitle");

    const wantsCsv = String(req.path || "").endsWith(".csv") || req.query?.format === "csv";

    if (!wantsCsv) {
      return res.status(200).json({
        window: { from, to },
        metrics,
        byModel,
      });
    }

    const rows = byModel.map((row) => ({
      model: row.name,
      quoted: row.quoted,
      paid: row.paid,
      rejected: row.rejected,
      expired: row.expired,
      revisedOffers: row.revisedOffers,
      acceptanceRatePercent: row.acceptanceRate ?? "",
      avgDeductionPercent: row.avgDeductionPercent ?? "",
      paidOut: (row.paidOutCents / 100).toFixed(2),
    }));

    const csv = toCsv(rows);

    res.set("Content-Type", "text/csv; charset=utf-8");
    // Dated, because a file called trade-ins.csv in a downloads folder is
    // indistinguishable from the last four.
    res.set(
      "Content-Disposition",
      `attachment; filename="upcell-trade-ins-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`
    );
    return res.status(200).send(csv);
  } catch (error) {
    return next(error);
  }
}


module.exports = {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  recordTradeInPayout,
  getTradeInReport,
  getMyTradeIns,
  deleteTradeInRequest,
  amountOwed,
};
