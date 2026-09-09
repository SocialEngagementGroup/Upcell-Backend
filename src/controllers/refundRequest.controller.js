const Order = require("../models/order.model");
const AuditLog = require("../models/auditLog.model");
const { Notification } = require("../models/notification.model");
const RefundRequest = require("../models/refundRequest.model");
const { ALLOWED_TRANSITIONS, ACTIVE_STATUSES } = require("../models/refundRequest.model");
const { calculateRefund } = require("../services/refund");
const { applyTransition, recordEvent } = require("../services/returnTimeline");
const { summariseForQueue } = require("../services/returnRiskFlags");
const { issueRmaNumber } = require("../utils/rma");
const { reasonCategory, faultAttributionFor } = require("../constants/returnReasons");
const { issueRma } = require("../services/returnAuthorisation");
const {
  checkReturnEligibility,
  checkSelectedItems,
  returnWindowClosesAt,
} = require("../services/refundEligibility");
const { getAdminListPagination, sendPaginatedResults } = require("../utils/pagination");
const { Resend } = require("resend");
const {
  refundRequestReceivedEmail,
  refundReturnInstructionsEmail,
  refundDeviceReceivedEmail,
  refundRejectedEmail,
  refundApprovedEmail,
  refundMoneySentEmail,
} = require("../services/emailTemplates");

const resend = new Resend(process.env.RESEND_KEY);
const orderEmailFrom = process.env.EMAIL_FROM;

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// Fire-and-forget, matching every other send in the project. A refund request
// that has already been written must not be undone because a mail server was
// slow, and the customer chasing a missing email is a far smaller problem than
// a device stuck in a state nobody can move.
function sendEmail(to, built) {
  if (!to || !built) return;
  resend.emails
    .send({ from: orderEmailFrom, to: [to], subject: built.subject, html: built.html })
    .catch((error) => {
      console.error("[refund-request] email failed:", error?.message || error);
    });
}

// The names the customer recognises, for the items they chose — the ids mean
// nothing to them.
const namesForItems = (order, itemIds) => {
  const wanted = new Set((itemIds || []).map(String));
  return (order.line_items || [])
    .filter((item) => wanted.has(String(item?.price_data?.product_data?.metadata?.productId)))
    .map((item) => item.price_data.product_data.name);
};

// Ownership, not just authentication. Without this a signed-in customer could
// open a refund request against somebody else's order by changing the id — the
// same class of hole getClientOrders guards against.
const ownsOrder = (order, user) =>
  user?.role === "admin" || (order?.userId && order.userId === user?.id) || order?.email === user?.email;

/**
 * What the customer sees before filling the form: which items can go back, and
 * how long they have left.
 *
 * Returns 200 with ok:false rather than an error status when the order simply
 * is not returnable. The page needs to render the reason ("delivered
 * yesterday, window opens then" / "closed on the 3rd"), and a 4xx would send
 * the frontend down its generic error path instead.
 */
async function getRefundableItems(req, res, next) {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id || "")) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (!ownsOrder(order, req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const eligibility = checkReturnEligibility(order);
    if (!eligibility.ok) {
      return res.status(200).json({ ok: false, reason: eligibility.reason, message: eligibility.message });
    }

    const existing = await RefundRequest.findOne({
      orderId: order._id,
      status: { $in: ACTIVE_STATUSES },
    }).lean();

    if (existing) {
      return res.status(200).json({
        ok: false,
        reason: "request_open",
        message: "There is already a refund request open for this order.",
        requestId: existing._id,
        status: existing.status,
      });
    }

    res.status(200).json({
      ok: true,
      closesAt: eligibility.closesAt,
      // Only what the form needs to draw a row per item.
      items: eligibility.items.map((item) => ({
        productId: item.price_data.product_data.metadata.productId,
        name: item.price_data.product_data.name,
        image: item.price_data.product_data.images?.[0],
        paid: item.price_data.product_data.metadata.totalPaid,
      })),
      // Stated, not calculated. The exact figure depends on what staff decide
      // about the fee after inspection, and quoting it now would read as a
      // promise.
      feeNotice:
        "A 15% restocking fee applies. The sales tax you paid on returned items is refunded; shipping is not.",
    });
  } catch (error) {
    next(error);
  }
}

async function createRefundRequest(req, res, next) {
  const { orderId, itemIds, reason, reasonCode } = req.body;

  try {
    const order = await Order.findById(orderId || null);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (!ownsOrder(order, req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const eligibility = checkReturnEligibility(order);
    if (!eligibility.ok) {
      return res.status(400).json({ error: eligibility.message });
    }

    const selection = checkSelectedItems(order, itemIds);
    if (!selection.ok) {
      return res.status(400).json({ error: selection.message });
    }

    // Checked here as well as enforced by the partial index below. The check
    // gives the customer a sentence they can act on; the index is what actually
    // holds when two submissions arrive at once.
    const open = await RefundRequest.findOne({
      orderId: order._id,
      status: { $in: ACTIVE_STATUSES },
    }).lean();

    if (open) {
      return res.status(409).json({
        error: "There is already a refund request open for this order.",
      });
    }

    let request;
    try {
      request = await RefundRequest.create({
        orderId: order._id,
        userId: req.user?.id,
        email: order.email,
        itemIds: selection.itemIds,
        reason,
        reasonCode,
        reasonCategory: reasonCode ? reasonCategory(reasonCode) : null,
        // Derived from the reason, not posted. It decides who pays the postage
        // and whether the 15% fee applies, so it is not the customer's to set.
        faultAttribution: reasonCode ? faultAttributionFor(reasonCode) : null,
        // The first entry in the dispute record: the customer asked, and when.
        timeline: [
          {
            at: new Date(),
            actor: req.user?.id || "customer",
            actorType: "customer",
            event: "requested",
            to: "Submitted",
            meta: { reasonCode: reasonCode || null },
          },
        ],
      });
    } catch (error) {
      // The partial unique index rejected a second live request. Two clicks on
      // a slow connection reach here rather than creating a duplicate.
      if (error?.code === 11000) {
        return res.status(409).json({
          error: "There is already a refund request open for this order.",
        });
      }
      throw error;
    }

    Notification.create({
      type: "order",
      title: "New refund request",
      message: `${order.email} asked to return ${selection.itemIds.length} item${selection.itemIds.length === 1 ? "" : "s"}.`,
      link: `/admin-secret/refund-requests`,
      relatedId: request._id,
    }).catch((error) => {
      console.error("[refund-request] notification failed:", error?.message || error);
    });

    sendEmail(
      order.email,
      refundRequestReceivedEmail({
        requestId: request._id,
        orderId: order._id,
        itemNames: namesForItems(order, selection.itemIds),
      })
    );

    res.status(201).json({ request });
  } catch (error) {
    next(error);
  }
}

async function getMyRefundRequests(req, res, next) {
  try {
    const requests = await RefundRequest.find({ userId: req.user?.id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(requests);
  } catch (error) {
    next(error);
  }
}

async function getAdminRefundRequests(req, res, next) {
  try {
    const { page, limit, skip } = getAdminListPagination(req);
    const status = req.params.status;
    const query = status && status !== "all" ? { status } : {};

    // Oldest first for the approval queue, newest first everywhere else.
    //
    // A queue of work is worked through in the order it arrived — the request
    // that has been waiting longest is the one a customer is most annoyed
    // about. Every other tab is a record being looked at, where the most
    // recent is what someone wants.
    const sort = status === "Submitted" ? { createdAt: 1 } : { createdAt: -1 };

    const [requests, totalItems] = await Promise.all([
      RefundRequest.find(query).sort(sort).skip(skip).limit(limit),
      RefundRequest.countDocuments(query),
    ]);

    // The numbers a staff member reads before approving: order value, how long
    // since delivery, and whether anything about this one deserves a second
    // look. Computed here rather than on the client so the rules live in one
    // place and the same answer reaches the email and the report.
    const orderIds = [...new Set(requests.map((request) => String(request.orderId)))];
    const userIds = [...new Set(requests.map((request) => request.userId).filter(Boolean))];

    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    const [orders, priorCounts] = await Promise.all([
      Order.find({ _id: { $in: orderIds } }).select("totalCents deliveredAt").lean(),
      // How many returns each of these customers has had in the last year, not
      // counting the ones on screen. Grouped in one query rather than one per
      // row, which at 25 rows a page is 25 round trips saved.
      RefundRequest.aggregate([
        { $match: { userId: { $in: userIds }, createdAt: { $gte: yearAgo } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ]),
    ]);

    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    const priorByUser = new Map(priorCounts.map((row) => [row._id, row.count]));

    // Same response shape sendPaginatedResults produces, because the admin UI
    // and every other admin list already read items/pagination. The only
    // difference is `queue` on each row.
    const items = requests.map((request) => {
      const plain = typeof request.toObject === "function" ? request.toObject() : { ...request };

      return {
        ...plain,
        queue: summariseForQueue({
          request: plain,
          order: orderById.get(String(request.orderId)),
          // Minus this one: a customer's first return should not read as one
          // previous return.
          priorReturns: Math.max((priorByUser.get(request.userId) || 0) - 1, 0),
        }),
      };
    });

    res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Moves a request through the workflow, and is the only place that does.
 *
 * Each step demands what that step is actually for: return instructions cannot
 * be sent empty, a rejection cannot be given without a reason the customer can
 * be told, and a device cannot be approved without a note about what it looked
 * like. Requiring them here rather than trusting the form means the record is
 * complete whoever wrote the client.
 */
async function updateRefundRequestStatus(req, res, next) {
  const { status, returnInstructions, rejectionReason, inspectionNotes, waiveRestockingFee, waiveReason } = req.body;

  try {
    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    const allowed = ALLOWED_TRANSITIONS[request.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `A request that is ${request.status} cannot become ${status}.`,
        allowed,
      });
    }

    const order = await Order.findById(request.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const previousStatus = request.status;

    if (status === "ReturnApproved") {
      if (!String(returnInstructions || "").trim()) {
        return res.status(400).json({
          error: "Return instructions are required — this is what the customer is sent.",
        });
      }
      request.returnInstructions = returnInstructions.trim();

      // The RMA is issued here, not at submission. A request nobody has agreed
      // to yet has nothing to authorise, and handing out a number for a return
      // that then gets declined leaves the customer holding a reference that
      // means nothing.
      //
      // Only once: re-approving an already-approved request must not renumber
      // it, because the first number is on a box in the post by then.
      if (!request.rmaNumber) {
        await issueRma(request, { RefundRequest, issueRmaNumber });
      }
    }

    if (status === "DeviceReceived") {
      request.receivedAt = new Date();
      request.receivedBy = req.user?.email;
    }

    if (status === "Rejected") {
      if (!String(rejectionReason || "").trim()) {
        return res.status(400).json({
          error: "A rejection reason is required — the customer is told why.",
        });
      }
      request.rejectionReason = rejectionReason.trim();
      // A rejection after the device arrived is an inspection outcome, so the
      // notes belong on the record just as they would on an approval.
      if (previousStatus === "DeviceReceived") {
        request.inspectionNotes = inspectionNotes;
        request.inspectedBy = req.user?.email;
        request.inspectedAt = new Date();
      }
    }

    // Approving is the point where money is committed to. Everything before it
    // is process; this writes the figure onto the order, which is what the
    // existing RefundPanel and the customer's email both read.
    if (status === "Approved") {
      if (order.refund?.approvedAt) {
        return res.status(400).json({ error: "This order has already been refunded." });
      }

      const result = calculateRefund(order, {
        itemIds: request.itemIds,
        // The reason the customer gave when they asked. It decides whether the
        // 15% restocking fee applies at all — a faulty device is never charged
        // it. Staff can still waive it on top for a change-of-mind return.
        reasonCode: request.reasonCode,
        waiveRestockingFee: Boolean(waiveRestockingFee),
        waiveReason,
      });

      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }

      request.inspectionNotes = inspectionNotes;
      request.inspectedBy = req.user?.email;
      request.inspectedAt = new Date();
      request.calculatedAmount = result.refundAmount;

      order.refund = {
        itemsTotal: result.itemsTotal,
        restockingFee: result.restockingFee,
        restockingFeeWaived: result.restockingFeeWaived,
        waiveReason: result.restockingFeeWaived ? waiveReason : undefined,
        taxRefunded: result.taxRefunded,
        amount: result.refundAmount,
        itemIds: request.itemIds,
        notes: inspectionNotes,
        approvedBy: req.user?.email,
        approvedAt: new Date(),
      };
      // Refunded stays paid:true — the charge did happen.
      order.status = "Refunded";
      await order.save();
    }

    // The request only reaches Refunded when a person confirms they typed the
    // figure into the Business Center. That is the same fact order.refund
    // records, so it is stamped in both places from this one action rather than
    // leaving staff a second box to tick somewhere else.
    if (status === "Refunded") {
      if (!order.refund?.approvedAt) {
        return res.status(400).json({ error: "This order has no recorded refund." });
      }
      if (!order.refund.enteredAtBankAt) {
        order.refund.enteredAtBankAt = new Date();
        order.refund.enteredAtBankBy = req.user?.email;
        await order.save();
      }
    }

    // Through the state machine, never by assignment. The transition was
    // already checked above; applyTransition re-checks it and writes the
    // timeline entry in the same step, so a status can never change without a
    // record of who changed it. That log is what answers a disputed return.
    const moved = applyTransition(request, status, {
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      meta: {
        ...(returnInstructions ? { returnInstructions: request.returnInstructions } : {}),
        ...(rejectionReason ? { rejectionReason: request.rejectionReason } : {}),
        ...(request.rmaNumber ? { rmaNumber: request.rmaNumber } : {}),
        ...(status === "Approved" ? { calculatedAmount: request.calculatedAmount } : {}),
      },
    });

    if (!moved.ok) {
      return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    }

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.status_update",
      targetType: "RefundRequest",
      targetId: request._id,
      metadata: { from: previousStatus, to: status, orderId: String(order._id) },
    }).catch((error) => {
      console.error("[audit] refund_request.status_update log failed:", error);
    });

    // One email per stage, sent after the record is saved so a customer is
    // never told about a state that failed to persist.
    const itemNames = namesForItems(order, request.itemIds);
    const common = { requestId: request._id, orderId: order._id, itemNames };

    if (status === "ReturnApproved") {
      sendEmail(request.email, refundReturnInstructionsEmail({ ...common, instructions: request.returnInstructions }));
    } else if (status === "DeviceReceived") {
      sendEmail(request.email, refundDeviceReceivedEmail(common));
    } else if (status === "Approved") {
      sendEmail(
        request.email,
        refundApprovedEmail({
          orderId: order._id,
          itemNames,
          itemsTotal: order.refund.itemsTotal,
          restockingFee: order.refund.restockingFee,
          taxRefunded: order.refund.taxRefunded,
          refundAmount: order.refund.amount,
        })
      );
    } else if (status === "Rejected") {
      sendEmail(request.email, refundRejectedEmail({ ...common, rejectionReason: request.rejectionReason }));
    } else if (status === "Refunded") {
      sendEmail(request.email, refundMoneySentEmail({ ...common, refundAmount: order.refund.amount }));
    }

    res.json({ request });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getRefundableItems,
  createRefundRequest,
  getMyRefundRequests,
  getAdminRefundRequests,
  updateRefundRequestStatus,
};
