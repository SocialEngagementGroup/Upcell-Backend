const Order = require("../models/order.model");
const AuditLog = require("../models/auditLog.model");
const { Notification } = require("../models/notification.model");
const RefundRequest = require("../models/refundRequest.model");
const { ALLOWED_TRANSITIONS, ACTIVE_STATUSES } = require("../models/refundRequest.model");
const { calculateRefund } = require("../services/refund");
const { applyTransition, recordEvent } = require("../services/returnTimeline");
const { summariseForQueue } = require("../services/returnRiskFlags");
const { issueRmaNumber } = require("../utils/rma");
const {
  reasonCategory,
  faultAttributionFor,
  returnPolicyFor,
  RETURN_REASONS,
  RETURN_REASON_CODES,
} = require("../constants/returnReasons");
const {
  resolveWindowStart,
  validateOverride,
} = require("../services/returnWindow");
const { issueRma } = require("../services/returnAuthorisation");
const {
  validateShipment,
  trackingNumberInUse,
  recordInboundLeg,
  recordOutboundLeg,
  recordUndeliverable,
  awaitingShipBack,
} = require("../services/returnShipping");
const {
  validateInspection,
  batteryHealthFrom,
  cosmeticGradeFrom,
  suggestOutcome,
  suggestDisposition,
  gradeFrom,
  stampPurgeDates,
} = require("../services/returnInspection");
const { CHECKLIST_ITEMS, PHOTO_GUIDANCE } = require("../constants/inspectionChecklist");
const {
  buildRevisedOffer,
  offerExpiryFrom,
  offerHasExpired,
} = require("../services/revisedOffer");
const { createAccessToken, tokensMatch } = require("../utils/accessToken");
const { startClock, syncClockToStatus, isOverdue, hoursRemaining } = require("../services/returnSla");
const {
  validateDisposition,
  relistDevice,
  internalRecordFor,
} = require("../services/returnDisposition");
const {
  DISPOSITIONS,
  DISPOSITION_TYPES,
  REQUIRES_REASON,
  relists,
  sourceAllows,
} = require("../constants/dispositions");
const { GRADES } = require("../constants/grading");
const SingleVariation = require("../models/singleVariation.model");
const { buildReturnMetrics, groupReturns, toCsv } = require("../services/returnReporting");
const {
  defaultMethodFor,
  validateSettlement,
  outcomeFor,
} = require("../services/returnSettlement");
const {
  checkReturnEligibility,
  checkSelectedItems,
  returnWindowClosesAt,
} = require("../services/refundEligibility");
const { getAdminListPagination, sendPaginatedResults } = require("../utils/pagination");
const { Resend } = require("resend");
const {
  refundRequestReceivedEmail,
  returnLabelIssuedEmail,
  revisedOfferEmail,
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
// Which physical devices the order says are coming back.
//
// Reads the typed items array first and falls back to the legacy line_items,
// because both shapes are live: orders written since the migration have items,
// older ones have only line_items, and a return can be opened against either.
// Anything with no identifier recorded is still listed — the inspection screen
// has to be able to say "this order never recorded an IMEI", which is a
// different thing from showing nothing at all.
const soldDevicesFor = (order, itemIds) => {
  const wanted = new Set((itemIds || []).map(String));

  const fromItems = (order.items || [])
    .filter((item) => wanted.has(String(item?.productId)))
    .map((item) => ({
      productId: String(item.productId),
      name: item.name,
      imei: item.imei || undefined,
      serial: item.serialNumber || undefined,
    }));

  if (fromItems.length) return fromItems;

  return (order.line_items || [])
    .filter((line) =>
      wanted.has(String(line?.price_data?.product_data?.metadata?.productId)),
    )
    .map((line) => {
      const productData = line.price_data.product_data;
      return {
        productId: String(productData.metadata.productId),
        name: productData.name,
        imei: productData.metadata.imei || undefined,
        serial: productData.metadata.serialNumber || undefined,
      };
    });
};

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

    // The window depends on why it is coming back - 14 days for a change of
    // mind, 30 for a fault - so the form passes the chosen reason back as the
    // customer picks it. Without one, the longest window applies, which is what
    // an order-history page wants before anything has been chosen.
    const reasonCode = req.query?.reasonCode;
    const eligibility = checkReturnEligibility(order, { reasonCode });
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

    const items = eligibility.items.map((item) => ({
      productId: item.price_data.product_data.metadata.productId,
      name: item.price_data.product_data.name,
      image: item.price_data.product_data.images?.[0],
      paid: item.price_data.product_data.metadata.totalPaid,
    }));

    // What the customer is choosing between, and what each choice costs them.
    // Sent as data rather than hard-coded in the form so the window, the
    // postage and the fee can never say one thing on screen and another in the
    // calculation.
    const reasons = RETURN_REASON_CODES.map((code) => {
      const policy = returnPolicyFor(code);
      return {
        code,
        label: RETURN_REASONS[code].label,
        category: policy.category,
        windowDays: policy.windowDays,
        customerPaysPostage: policy.customerPaysPostage,
        restockingFee: policy.restockingFee,
        requiresNote: policy.requiresNote,
      };
    });

    // An estimate, once the customer has picked a reason and some items.
    //
    // Calculated here rather than in the browser, on the same code path that
    // produces the real figure at approval - so the number quoted before they
    // commit and the number they are actually paid are arrived at the same way,
    // and cannot drift apart. It is still an estimate: inspection can change
    // the reason, and a device in worse condition than described gets a revised
    // offer instead.
    const selected = req.query?.itemIds
      ? String(req.query.itemIds).split(",").map((id) => id.trim()).filter(Boolean)
      : null;

    let estimate = null;
    if (reasonCode) {
      const result = calculateRefund(order, {
        itemIds: selected && selected.length ? selected : undefined,
        reasonCode,
      });

      if (result.ok) {
        estimate = {
          itemsTotal: result.itemsTotal,
          restockingFee: result.restockingFee,
          taxRefunded: result.taxRefunded,
          refundAmount: result.refundAmount,
          // Postage is not deducted here. UpCell issues the label and the cost
          // is known when it is bought, not now - so quoting a number for it
          // would be inventing one. The form says who pays instead.
          customerPaysPostage: returnPolicyFor(reasonCode).customerPaysPostage,
        };
      }
    }

    res.status(200).json({
      ok: true,
      closesAt: eligibility.closesAt,
      windowDays: eligibility.windowDays,
      items,
      reasons,
      estimate,
      // One sentence, true for every reason. It used to vary, and before that
      // it promised a 15% fee to everyone including customers returning a
      // device that would not power on.
      feeNotice:
        "Returns are free — we pay the postage both ways and there is no restocking fee. The sales tax you paid on returned items comes back in full; original shipping does not.",
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

    // Checked against the reason the customer actually chose, not the longest
    // window. Otherwise a change-of-mind return submitted on day 20 would pass
    // here after the form had already told them it was out of time.
    const eligibility = checkReturnEligibility(order, { reasonCode });
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
        // What should be arriving, taken from the order now rather than looked
        // up at inspection: the catalogue record behind an order line can be
        // edited or deleted in the weeks a return takes to come back.
        device: { expected: soldDevicesFor(order, selection.itemIds) },
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

      // How many times this customer has been rejected before. Recorded on the
      // request so the ship-back queue and any later dispute can see it without
      // re-counting, and surfaced to staff — never an automatic block. A person
      // rejected twice may still be right the third time, and the deterrent
      // against frivolous returns is the 15% fee, not a system that refuses
      // people.
      request.priorRejections = await RefundRequest.countDocuments({
        userId: request.userId,
        status: { $in: ["Rejected", "ReturnShipped"] },
        _id: { $ne: request._id },
      });
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

    // An accepted return cannot close until somebody has said where the device
    // went. Otherwise the process ends at the refund and the phone becomes
    // something on a shelf that nobody is responsible for — which is the exact
    // gap the disposition model exists to close.
    //
    // Only for returns that were accepted: a rejected device is going back to
    // the customer, so there is nothing to route.
    if (status === "Closed" && request.status === "Refunded" && !request.disposition?.type) {
      return res.status(400).json({
        error: "Record where the device went before closing this return.",
        dispositions: DISPOSITION_TYPES,
      });
    }

    // A rejected return cannot close while UpCell is still holding the device.
    // That is how a phone ends up on a shelf with nobody responsible for it and
    // a customer who has stopped being told anything.
    if (status === "Closed" && awaitingShipBack(request)) {
      return res.status(400).json({
        error: "This device has not been sent back yet. Record the ship-back before closing the return.",
      });
    }

    // Through the state machine, never by assignment. The transition was
    // already checked above; applyTransition re-checks it and writes the
    // timeline entry in the same step, so a status can never change without a
    // record of who changed it. That log is what answers a disputed return.
    const moved = moveStatus(request, status, {
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

/**
 * Attaches the return label and tracking number, and tells the customer.
 *
 * Phase 1 of the shipping work: a staff member buys the label in FedEx Ship
 * Manager, uploads it, and types the number in. R.14 replaces this body with a
 * call to the FedEx Ship API — everything downstream reads the same fields and
 * does not care which of the two wrote them.
 *
 * This is also the first email the customer can act on. Until the label exists
 * they have a number and no way to use it.
 */
async function recordReturnLabel(req, res, next) {
  try {
    const { carrier, trackingNumber, labelUrl, labelCost } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    const shipment = validateShipment({ carrier, trackingNumber, labelUrl });
    if (!shipment.ok) return res.status(400).json({ error: shipment.error });

    // Two live returns sharing a tracking number means the receiving desk scans
    // a parcel and gets two answers, and a carrier update advances the wrong
    // one. Excludes this request, so fixing a typo on it is not a clash with
    // itself.
    const clash = await trackingNumberInUse({
      RefundRequest,
      activeStatuses: ACTIVE_STATUSES,
      trackingNumber: shipment.trackingNumber,
      exceptId: request._id,
    });

    if (clash) {
      return res.status(409).json({
        error: `That tracking number is already on another open return${clash.rmaNumber ? ` (${clash.rmaNumber})` : ""}.`,
      });
    }

    recordInboundLeg(request, {
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      labelUrl: shipment.labelUrl,
      labelCost,
    });

    // Only moves the status when there is somewhere to move to. Re-uploading a
    // corrected label onto a request already in LabelIssued should replace the
    // file, not fail because the transition is illegal.
    if (request.status === "ReturnApproved") {
      const moved = moveStatus(request, "LabelIssued", {
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
      });

      if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    } else {
      recordEvent(request, {
        event: "label_replaced",
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
      });
    }

    await request.save();

    const order = await Order.findById(request.orderId);

    sendEmail(
      request.email,
      returnLabelIssuedEmail({
        rmaNumber: request.rmaNumber,
        orderId: String(request.orderId),
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        labelUrl: shipment.labelUrl,
        expiresAt: request.rma?.expiresAt,
        itemNames: namesForItems(order, request.itemIds),
      })
    );

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.label_issued",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: {
        rmaNumber: request.rmaNumber,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
      },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: request.status,
      rmaNumber: request.rmaNumber,
      shipping: request.shipping,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Finds a return by its RMA or a tracking number.
 *
 * How a parcel on the receiving bench becomes a record on screen. Looking it up
 * is the point: staff must never create a new record for something that
 * arrived, because then the customer's request stays open forever alongside a
 * duplicate that has no history.
 */
async function lookupReturnRequest(req, res, next) {
  try {
    const term = String(req.query?.q || "").trim();
    if (term.length < 4) {
      return res.status(400).json({ error: "Enter an RMA number or a tracking number." });
    }

    const normalised = term.toUpperCase();

    const request = await RefundRequest.findOne({
      $or: [
        { rmaNumber: normalised },
        { "shipping.inbound.trackingNumber": normalised },
        { "shipping.outbound.trackingNumber": normalised },
      ],
    }).lean();

    if (!request) {
      return res.status(404).json({
        error: "No return found for that number.",
        // Said explicitly, because the wrong instinct here is to create one.
        hint: "Check the RMA on the box, or the tracking number on the label. Do not create a new request for a parcel that has arrived.",
      });
    }

    return res.status(200).json({ ok: true, request });
  } catch (error) {
    return next(error);
  }
}

/**
 * The checklist an inspector fills in, and what each photo is for.
 *
 * Sent from the server rather than written into the admin page so the list the
 * inspector answers and the list the validation demands are the same list. Two
 * copies drift, and the one that drifts is always the one on screen.
 */
function getInspectionChecklist(req, res) {
  return res.status(200).json({
    items: CHECKLIST_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      critical: Boolean(item.critical),
      onlyWhenFaultClaimed: Boolean(item.onlyWhenFaultClaimed),
      drivesDisposition: Boolean(item.drivesDisposition),
      // Two checks do not answer with pass or fail. Sent so the bench form
      // knows to draw a number box and a grade list instead of three buttons
      // — without these the page cannot collect what the server demands.
      measured: Boolean(item.measured),
      graded: Boolean(item.graded),
      neverDeducts: Boolean(item.neverDeducts),
    })),
    photoGuidance: PHOTO_GUIDANCE,
    // The scale the graded check answers on, from the same constant the
    // grading service reads.
    grades: Object.values(GRADES),
  });
}

/**
 * Records a completed inspection and says what it points to.
 *
 * Submitting does not settle anything. It writes what was found, suggests an
 * outcome and a disposition, and moves the request to the state that outcome
 * implies — a person still approves, offers less, or rejects from there. The
 * suggestion exists so the obvious cases stop needing thought, not so the hard
 * ones get decided by a lookup table.
 */
async function submitInspection(req, res, next) {
  try {
    const { checklist, photos, findings, grade: gradeOverride } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    // Inspection follows a person holding the device. A carrier saying
    // "delivered" is a claim about a doorstep.
    if (!["DeviceReceived", "InInspection", "ActionRequired"].includes(request.status)) {
      return res.status(400).json({
        error: `A return cannot be inspected while it is ${request.status}. It has to be received first.`,
      });
    }

    // Whether the customer claimed something was wrong with it. Decides
    // whether the "fault reproduced" check has to be answered at all.
    const faultClaimed = request.reasonCategory === "PRODUCT_FAULT";

    const validation = validateInspection({ checklist, photos: photos || [], faultClaimed });
    if (!validation.ok) {
      return res.status(400).json({
        error: "This inspection is not complete.",
        details: validation.errors,
      });
    }

    // What the listing said when it sold. The regrade compares against this,
    // not against what the listing says today — it can have been re-graded and
    // relisted while this return was still in the post.
    const gradeAtSale = request.device?.gradeAtSale;

    const outcome = suggestOutcome({
      checklist: validation.checklist,
      reasonCode: request.reasonCode,
      faultClaimed,
      gradeAtSale,
    });
    const disposition = suggestDisposition({
      checklist: validation.checklist,
      outcome: outcome.outcome,
      gradeAtSale,
    });
    const grade = gradeOverride || gradeFrom(validation.checklist);

    request.inspection = {
      inspectorId: req.user?.email || req.user?.id,
      startedAt: request.inspection?.startedAt || new Date(),
      completedAt: new Date(),
      checklist: validation.checklist,
      // Recorded for the relisting and for reporting. Never a deduction.
      batteryHealth: batteryHealthFrom(validation.checklist),
      cosmeticGrade: cosmeticGradeFrom(validation.checklist),
      finalGrade: grade,
      grade,
      photos: stampPurgeDates(photos || []),
      findings,
    };

    // Kept for the existing admin panel and the customer's email, both of
    // which already read these.
    request.inspectedBy = req.user?.email;
    request.inspectedAt = new Date();
    if (findings) request.inspectionNotes = findings;

    // A device that has arrived but was never opened is moved into inspection
    // first. The outcomes branch from InInspection, not from DeviceReceived —
    // the plan's own diagram works that way, and it means the record shows the
    // inspection having started rather than a device jumping from a shelf to a
    // verdict.
    if (request.status === "DeviceReceived") {
      const opened = moveStatus(request, "InInspection", {
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        event: "inspection_started",
      });

      if (!opened.ok) return res.status(400).json({ error: opened.error, allowed: opened.allowed });
    }

    // Where the suggestion sends it. ActionRequired and RevisedOffer both stop
    // the settlement clock, because from here UpCell is waiting on the
    // customer rather than the other way round.
    const nextStatus = {
      ACTION_REQUIRED: "ActionRequired",
      REVISED_OFFER: "RevisedOffer",
      REJECT: "Rejected",
      FULL_REFUND: "InInspection",
    }[outcome.outcome];

    if (nextStatus && nextStatus !== request.status) {
      const moved = moveStatus(request, nextStatus, {
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        event: "inspection_completed",
        meta: { grade, outcome: outcome.outcome, reason: outcome.reason },
      });

      if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    } else {
      recordEvent(request, {
        event: "inspection_completed",
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        meta: { grade, outcome: outcome.outcome },
      });
    }

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.inspection_completed",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { grade, outcome: outcome.outcome, photoCount: (photos || []).length },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: request.status,
      grade,
      // Labelled suggestions, because a staff member can and should override
      // them with a reason.
      suggested: { ...outcome, disposition },
      inspection: request.inspection,
    });
  } catch (error) {
    return next(error);
  }
}

// Where the customer answers an offer. Built here so the links in the email and
// the routes that serve them cannot drift apart.
const SITE_URL = process.env.FRONTEND_URL || process.env.SITE_URL || "";

// Every status change goes through here so the SLA clock cannot fall out of
// step with the status. A rule applied by hand in six controllers is a rule
// that is wrong in one of them.
function moveStatus(request, to, options) {
  const result = applyTransition(request, to, options);
  if (!result.ok) return result;

  // The promise starts when UpCell knows what it owes, which is the end of
  // inspection — not when the device arrived, and not when it was requested.
  if (to === "InInspection" && !request.sla?.clockStartedAt) startClock(request);

  syncClockToStatus(request, to);
  return result;
}
const offerLink = (request, action) =>
  `${SITE_URL}/returns/${request._id}/${action}?token=${request.accessToken}`;

/**
 * Offers the customer less than the full refund, itemised.
 *
 * Staff judge the amounts — how much a scuffed back is worth is not something
 * a lookup table knows — but every deduction has to name the inspection check
 * that justifies it, and the offered total is computed here rather than posted.
 * A customer asking "why is this less" gets a list, not a smaller number.
 */
async function offerRevisedRefund(req, res, next) {
  try {
    const { deductions, findings } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null).select("+accessToken");
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    if (request.status !== "InInspection") {
      return res.status(400).json({
        error: `A revised offer can only be made during inspection. This return is ${request.status}.`,
      });
    }

    // One offer per return.
    //
    // A second one re-opens a number the customer has already been given five
    // days to think about, and the accept link in their inbox would still point
    // at the first amount. If an offer was wrong, reject the return and let the
    // customer decide against the honest position rather than negotiating by
    // email.
    if (request.refundBreakdown?.offeredAmount != null) {
      return res.status(409).json({
        error:
          "This return has already been offered a revised refund. Wait for the customer to answer, or reject it.",
        offeredAmount: request.refundBreakdown.offeredAmount,
        offerExpiresAt: request.refundBreakdown.offerExpiresAt,
      });
    }

    const order = await Order.findById(request.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // What the customer would have been paid if the device had been as
    // described. Deductions come off this, not off the order total, so
    // shipping and unreturned items are never quietly included.
    const full = calculateRefund(order, {
      itemIds: request.itemIds,
      reasonCode: request.reasonCode,
    });
    if (!full.ok) return res.status(400).json({ error: full.error });

    const offer = buildRevisedOffer({
      itemsTotal: full.refundAmount,
      deductions,
      checklist: request.inspection?.checklist || [],
    });

    if (!offer.ok) {
      return res.status(400).json({ error: "This offer cannot be sent.", details: offer.errors });
    }

    const expiresAt = offerExpiryFrom();

    request.refundBreakdown = {
      ...(request.refundBreakdown || {}),
      orderAmount: full.refundAmount,
      deductions: offer.deductions,
      offeredAmount: offer.offeredAmount,
      offerExpiresAt: expiresAt,
    };

    // Minted once and kept. A new token on every offer would break the link in
    // an email the customer already has open.
    if (!request.accessToken) request.accessToken = createAccessToken();

    {
      const moved = moveStatus(request, "RevisedOffer", {
        actor: req.user?.email || req.user?.id,
        actorType: "staff",
        event: "revised_offer_sent",
        meta: { offeredAmount: offer.offeredAmount, totalDeducted: offer.totalDeducted },
      });
      if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    }

    await request.save();

    sendEmail(
      request.email,
      revisedOfferEmail({
        rmaNumber: request.rmaNumber,
        originalAmount: full.refundAmount,
        offeredAmount: offer.offeredAmount,
        deductions: offer.deductions,
        findings: findings || request.inspection?.findings,
        acceptUrl: offerLink(request, "accept"),
        declineUrl: offerLink(request, "decline"),
        expiresAt,
      })
    );

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.revised_offer_sent",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { offeredAmount: offer.offeredAmount, totalDeducted: offer.totalDeducted },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: request.status,
      offeredAmount: offer.offeredAmount,
      deductions: offer.deductions,
      expiresAt,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The customer's answer, from the link in the email.
 *
 * Authenticated by the token on the request rather than by a session: this
 * arrives on a phone, months after they last signed in, and a login wall here
 * is how an offer times out and a device gets posted back for no reason.
 *
 * Accepting moves to Approved and the money follows the normal settlement path.
 * Declining rejects, which sends the device back at UpCell's cost.
 */
/**
 * The offer itself, for the page the email links to.
 *
 * The same token rule as the answer below, and the same deliberate silence:
 * a missing return and a wrong token both answer 404, so this cannot be used
 * to find out which ids exist.
 *
 * Allowlisted rather than stripped. The request document carries the
 * inspection, the timeline, staff names and internal notes, and none of that
 * belongs on a page reachable with a link. Listing what may leave is the only
 * version of this that stays correct when a field is added later.
 */
async function getRevisedOffer(req, res, next) {
  try {
    const request = await RefundRequest.findById(req.params.id || null).select("+accessToken");

    if (!request || !tokensMatch(req.query?.token, request.accessToken)) {
      return res.status(404).json({ error: "This link is not valid." });
    }

    const breakdown = request.refundBreakdown || {};

    return res.status(200).json({
      rmaNumber: request.rmaNumber,
      status: request.status,
      // Only while it is still answerable. Once it is not, the page says so
      // rather than offering a button that cannot work.
      answerable: request.status === "RevisedOffer" && !offerHasExpired(request),
      expired: offerHasExpired(request),
      originalAmount: breakdown.refundAmount ?? request.calculatedAmount ?? null,
      offeredAmount: breakdown.offeredAmount ?? null,
      offerExpiresAt: breakdown.offerExpiresAt ?? null,
      deductions: (breakdown.deductions || []).map((entry) => ({
        type: entry.type,
        amount: entry.amount,
        reason: entry.reason,
      })),
      findings: request.inspection?.findings || null,
      productName: request.productName || null,
    });
  } catch (error) {
    return next(error);
  }
}

async function respondToRevisedOffer(req, res, next) {
  try {
    const decision = req.params.decision;
    if (!["accept", "decline"].includes(decision)) {
      return res.status(400).json({ error: "Unknown decision." });
    }

    const request = await RefundRequest.findById(req.params.id || null).select("+accessToken");
    // Deliberately the same answer for a missing return and a wrong token. A
    // different one tells whoever is guessing which ids exist.
    if (!request || !tokensMatch(req.query?.token, request.accessToken)) {
      return res.status(404).json({ error: "This link is not valid." });
    }

    if (request.status !== "RevisedOffer") {
      return res.status(409).json({
        error: "This offer has already been answered.",
        status: request.status,
      });
    }

    if (offerHasExpired(request)) {
      return res.status(410).json({
        error: "This offer has expired and the device is on its way back to you.",
      });
    }

    const accepted = decision === "accept";
    const target = accepted ? "Approved" : "Rejected";

    if (!accepted) {
      request.rejectionReason = "The customer declined the revised refund offer.";
    }

    const moved = moveStatus(request, target, {
      // The customer, not a staff member. Which of the two answered is the
      // first thing anyone asks when an offer is later disputed.
      actor: request.userId || request.email,
      actorType: "customer",
      event: accepted ? "revised_offer_accepted" : "revised_offer_declined",
      meta: { offeredAmount: request.refundBreakdown?.offeredAmount },
    });

    if (!moved.ok) return res.status(400).json({ error: moved.error });

    if (accepted) {
      request.calculatedAmount = request.refundBreakdown?.offeredAmount;
      request.refundBreakdown.finalAmount = request.refundBreakdown?.offeredAmount;
      request.resolution = { ...(request.resolution || {}), outcome: "PARTIAL_ACCEPTED" };
    } else {
      request.resolution = { ...(request.resolution || {}), outcome: "PARTIAL_DECLINED" };
    }

    await request.save();

    return res.status(200).json({
      ok: true,
      status: request.status,
      decision,
      amount: accepted ? request.refundBreakdown?.offeredAmount : null,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Records that the customer has actually been paid.
 *
 * Nothing here moves money. UpCell pays by bank transfer or by handing over
 * cash, both of which happen outside this system; this is the record that it
 * happened, and it insists on being good enough to answer "who was paid, how
 * much, by whom, and what is the proof". An order status that says Refunded
 * with nothing behind it is indistinguishable from a mistake.
 */
async function settleRefundRequest(req, res, next) {
  try {
    const { method, amount, reference, receiptUrl, notes } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    if (request.status !== "Approved") {
      return res.status(400).json({
        error: `Only an approved return can be settled. This one is ${request.status}.`,
      });
    }

    const order = await Order.findById(request.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const settlement = validateSettlement({
      method: method || defaultMethodFor(order),
      amount,
      reference,
      receiptUrl,
      // What was agreed — the revised amount where there was an offer, and the
      // calculated refund otherwise.
      expectedAmount: request.refundBreakdown?.finalAmount
        ?? request.refundBreakdown?.offeredAmount
        ?? request.calculatedAmount,
    });

    if (!settlement.ok) return res.status(400).json({ error: settlement.error });

    const moved = moveStatus(request, "Refunded", {
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      event: "settled",
      meta: {
        method: settlement.settlement.settlementMethod,
        amount: settlement.settlement.settlementAmount,
      },
    });

    if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });

    request.resolution = {
      ...(request.resolution || {}),
      ...settlement.settlement,
      outcome: outcomeFor(request),
      settledAt: new Date(),
      settledBy: req.user?.email,
    };
    request.refundBreakdown = {
      ...(request.refundBreakdown || {}),
      finalAmount: settlement.settlement.settlementAmount,
    };
    if (notes) request.inspectionNotes = notes;

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.settled",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: {
        rmaNumber: request.rmaNumber,
        method: settlement.settlement.settlementMethod,
        amount: settlement.settlement.settlementAmount,
        reference: settlement.settlement.settlementRef,
      },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: request.status,
      resolution: request.resolution,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The counters at the top of the returns dashboard.
 *
 * Answers "what is waiting on us, and what have we already missed" in one
 * request. Overdue is the one that matters: a promise nobody is measuring is
 * not a promise.
 */
async function getReturnsDashboard(req, res, next) {
  try {
    const [counts, live] = await Promise.all([
      RefundRequest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      // Only the ones that can still be late. A settled return cannot become
      // overdue, however long ago its deadline was.
      RefundRequest.find({ status: { $in: ACTIVE_STATUSES } })
        .select("status sla rmaNumber email createdAt")
        .lean(),
    ]);

    const byStatus = Object.fromEntries(counts.map((row) => [row._id, row.count]));
    const overdue = live.filter((request) => isOverdue(request));

    return res.status(200).json({
      byStatus,
      queues: {
        awaitingApproval: byStatus.Submitted || 0,
        inTransit: (byStatus.LabelIssued || 0) + (byStatus.InTransit || 0) + (byStatus.Delivered || 0),
        awaitingInspection: byStatus.DeviceReceived || 0,
        // Paused, so not late — but still someone's job to chase.
        waitingOnCustomer: (byStatus.ActionRequired || 0) + (byStatus.RevisedOffer || 0),
        awaitingSettlement: byStatus.Approved || 0,
        overdue: overdue.length,
      },
      overdue: overdue
        .map((request) => ({
          _id: request._id,
          rmaNumber: request.rmaNumber,
          status: request.status,
          dueAt: request.sla?.dueAt,
          hoursLate: -(hoursRemaining(request) || 0),
        }))
        // Worst first: the one that has been late longest is the one to do now.
        .sort((left, right) => right.hoursLate - left.hoursLate),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Sends a rejected device back to the customer.
 *
 * UpCell pays. The alternative — holding the device until an already-unhappy
 * customer agrees to pay $12 — needs a payment-hold state, a chasing
 * mechanism, and somewhere to keep the phone meanwhile, to recover about the
 * cost of the postage. The deterrent against frivolous returns is the 15%
 * restocking fee, not this.
 */
async function shipRejectedDeviceBack(req, res, next) {
  try {
    const { carrier, trackingNumber, labelUrl, labelCost } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    if (request.status !== "Rejected") {
      return res.status(400).json({
        error: `Only a rejected return is sent back. This one is ${request.status}.`,
      });
    }

    const shipment = validateShipment({ carrier, trackingNumber, labelUrl });
    if (!shipment.ok) return res.status(400).json({ error: shipment.error });

    const clash = await trackingNumberInUse({
      RefundRequest,
      activeStatuses: ACTIVE_STATUSES,
      trackingNumber: shipment.trackingNumber,
      exceptId: request._id,
    });
    if (clash) {
      return res.status(409).json({
        error: `That tracking number is already on another open return${clash.rmaNumber ? ` (${clash.rmaNumber})` : ""}.`,
      });
    }

    recordOutboundLeg(request, {
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      labelUrl: shipment.labelUrl,
      labelCost,
    });

    const moved = moveStatus(request, "ReturnShipped", {
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      event: "shipped_back",
      meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, paidBy: "UPCELL" },
    });
    if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });

    await request.save();

    const order = await Order.findById(request.orderId);

    sendEmail(
      request.email,
      returnLabelIssuedEmail({
        rmaNumber: request.rmaNumber,
        orderId: String(request.orderId),
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        labelUrl: shipment.labelUrl,
        itemNames: namesForItems(order, request.itemIds),
      })
    );

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.shipped_back",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
    }).catch(() => {});

    return res.status(200).json({ ok: true, status: request.status, shipping: request.shipping });
  } catch (error) {
    return next(error);
  }
}

/**
 * Records that a ship-back came back — refused, or nobody was there.
 *
 * Starts a 60-day hold rather than disposing of anything. A customer who moved
 * house or was away should get an email, not a written-off phone.
 */
async function markShipBackUndeliverable(req, res, next) {
  try {
    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    if (!request.shipping?.outbound?.shippedAt) {
      return res.status(400).json({ error: "Nothing has been sent back on this return yet." });
    }

    recordUndeliverable(request, { reason: req.body?.reason });

    recordEvent(request, {
      event: "ship_back_undeliverable",
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      meta: {
        reason: req.body?.reason,
        disposeAfter: request.shipping.outbound.disposeAfter,
      },
    });

    await request.save();

    return res.status(200).json({
      ok: true,
      disposeAfter: request.shipping.outbound.disposeAfter,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Devices waiting to go back, and devices that came back undelivered.
 *
 * A rejected phone with no owner is the thing that quietly accumulates, so it
 * gets its own queue rather than living as a filter on the main list.
 */
async function getShipBackQueue(req, res, next) {
  try {
    const [awaiting, undelivered] = await Promise.all([
      RefundRequest.find({ status: "Rejected" })
        .select("rmaNumber email rejectionReason priorRejections updatedAt shipping")
        .sort({ updatedAt: 1 })
        .lean(),
      RefundRequest.find({ "shipping.outbound.undeliverableAt": { $exists: true } })
        .select("rmaNumber email shipping")
        .sort({ "shipping.outbound.disposeAfter": 1 })
        .lean(),
    ]);

    return res.status(200).json({
      // Oldest first: a device waiting longest is the one to post today.
      awaitingShipBack: awaiting.filter((request) => !request.shipping?.outbound?.shippedAt),
      undeliverable: undelivered.map((request) => ({
        _id: request._id,
        rmaNumber: request.rmaNumber,
        disposeAfter: request.shipping?.outbound?.disposeAfter,
        reason: request.shipping?.outbound?.undeliverableReason,
        daysLeft: request.shipping?.outbound?.disposeAfter
          ? Math.ceil(
              (new Date(request.shipping.outbound.disposeAfter).getTime() - Date.now())
                / (24 * 60 * 60 * 1000)
            )
          : null,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The routes a device can take, and what each one means.
 *
 * Served rather than written into the admin page for the same reason the
 * inspection checklist is: the list staff choose from and the list the server
 * accepts have to be one list.
 */
async function getDispositions(req, res, next) {
  try {
    // Optional, and only used to answer "is the supplier route open for this
    // one". Asked here rather than left for the save to refuse, so a staff
    // member does not pick a route, type a reason, and only then be told the
    // device came from a member of the public.
    let acquisitionSource;
    if (req.query?.requestId) {
      const request = await RefundRequest.findById(req.query.requestId)
        .select("itemIds")
        .lean();
      const productId = request?.itemIds?.[0];
      if (productId) {
        const unit = await SingleVariation.findById(productId)
          .select("acquisitionSource")
          .lean();
        acquisitionSource = unit?.acquisitionSource;
      }
    }

    return res.status(200).json({
      dispositions: DISPOSITION_TYPES.map((type) => ({
        type,
        label: DISPOSITIONS[type].label,
        description: DISPOSITIONS[type].description,
        // What the form has to do about each: put the unit back on sale, ask for
        // a new price, ask for a reason, or be unavailable for a device bought
        // from a member of the public.
        relists: Boolean(DISPOSITIONS[type].relists),
        reprices: Boolean(DISPOSITIONS[type].reprices),
        requiresReason: REQUIRES_REASON.includes(type),
        requiresBulkSource: Boolean(DISPOSITIONS[type].requiresBulkSource),
        // Only decided when a request was named. Undefined means "not asked",
        // which the form treats as available — the same permissive default the
        // server applies to a unit whose source was never recorded.
        ...(req.query?.requestId
          ? { unavailableReason: sourceAllows(type, acquisitionSource).error }
          : {}),
      })),
      grades: Object.values(GRADES),
      acquisitionSource,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Records where the device went, and puts it back on sale if it earned that.
 *
 * Only a sealed device restocks automatically. Everything else leaves an
 * internal record carrying the grade and the IMEI for whoever handles it next
 * — automatically listing an opened phone as new is the mistake this whole
 * model exists to prevent.
 */
async function recordDisposition(req, res, next) {
  try {
    const { type, reason, grade, imei, price } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Refund request not found" });

    // Only a device UpCell is keeping needs routing. One being sent back to the
    // customer has a destination already.
    if (!["Approved", "Refunded"].includes(request.status)) {
      return res.status(400).json({
        error: `A disposition is recorded once the return is accepted. This one is ${request.status}.`,
      });
    }

    // Where the unit came from decides whether the supplier route is even on
    // offer. Read from the catalogue rather than the request, because it is a
    // fact about the device rather than about this return.
    const productId = request.itemIds?.[0];
    const unit = productId
      ? await SingleVariation.findById(productId).select("acquisitionSource").lean()
      : null;

    const validation = validateDisposition({
      type,
      reason,
      // Falls back to what inspection worked out, so staff do not retype it.
      grade: grade || request.inspection?.finalGrade,
      imei,
      price,
      acquisitionSource: unit?.acquisitionSource,
    });
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { disposition } = validation;

    let relisted = null;
    if (relists(disposition.type)) {
      relisted = await relistDevice({
        SingleVariation,
        productId,
        disposition,
      });
    }

    request.disposition = {
      type: disposition.type,
      grade: disposition.grade,
      relistedAt: relisted?.ok ? new Date() : undefined,
      // The internal record a person acts on. Kept on the request rather than
      // in a second collection: the grade, IMEI and reason already live here,
      // and a separate table is a second place for the same facts to go stale.
      inventoryItemId: relisted?.ok ? String(productId) : undefined,
      decidedBy: req.user?.email || req.user?.id,
      decidedAt: new Date(),
    };
    if (disposition.imei) {
      request.device = { ...(request.device || {}), imei: disposition.imei };
    }

    recordEvent(request, {
      event: "disposition_recorded",
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      meta: {
        ...internalRecordFor(request, disposition),
        // Said plainly either way. A restock that silently failed leaves a
        // device off sale that everyone believes is on it.
        relisted: relisted ? relisted.ok : false,
        repriced: relisted?.repriced || false,
        relistError: relisted && !relisted.ok ? relisted.error : undefined,
      },
    });

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.disposition_recorded",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { type: disposition.type, grade: request.disposition.grade, relisted: relisted?.ok },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      disposition: request.disposition,
      relisted: relisted ? relisted.ok : false,
      // Surfaced, not swallowed: staff have to know if the shelf did not change.
      warning: relisted && !relisted.ok ? relisted.error : undefined,
      internalRecord: relists(disposition.type) ? undefined : internalRecordFor(request, disposition),
    });
  } catch (error) {
    return next(error);
  }
}

// The window a report covers. Defaults to the last 90 days, which is long
// enough for a pattern to show and short enough that a slow month does not
// hide behind a good quarter.
function reportWindow(query = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

  return { from, to };
}

/**
 * How many units were sold in the window — the denominator of the return rate.
 *
 * Counted from paid orders only. Including unpaid ones would inflate the
 * denominator and quietly flatter the return rate, which is exactly the number
 * somebody would use to argue nothing is wrong.
 */
async function unitsSoldBetween(from, to, filters = {}) {
  const match = {
    paid: true,
    createdAt: { $gte: from, $lte: to },
  };

  const pipeline = [
    { $match: match },
    { $unwind: "$items" },
    ...(filters.productName
      ? [{ $match: { "items.name": new RegExp(filters.productName, "i") } }]
      : []),
    { $group: { _id: null, units: { $sum: "$items.quantity" } } },
  ];

  const [result] = await Order.aggregate(pipeline);
  return result?.units || 0;
}

/**
 * The returns report.
 *
 * Answers the question the plan actually asks: is a particular model or batch
 * coming back more than the rest, and what is it coming back for.
 */
async function getReturnsReport(req, res, next) {
  try {
    const { from, to } = reportWindow(req.query);

    const query = { createdAt: { $gte: from, $lte: to } };
    if (req.query?.reasonCode) query.reasonCode = req.query.reasonCode;
    if (req.query?.category) query.reasonCategory = req.query.category;

    const requests = await RefundRequest.find(query)
      .select("status reasonCode reasonCategory faultAttribution createdAt resolution sla timeline disposition refundBreakdown itemIds rmaNumber")
      .lean();

    // The product each return was for, so the report can group by model. Read
    // from the catalogue rather than stored on the request: a return records
    // what was bought by id, and the name can change.
    const productIds = [...new Set(requests.flatMap((request) => request.itemIds || []))];
    const products = productIds.length
      ? await SingleVariation.find({ _id: { $in: productIds } })
          .select("productName storage")
          .lean()
      : [];
    const productById = new Map(products.map((product) => [String(product._id), product]));

    const enriched = requests.map((request) => {
      const product = productById.get(String(request.itemIds?.[0]));
      return {
        ...request,
        productName: product?.productName,
        storage: product?.storage,
      };
    });

    const filtered = enriched.filter((request) => {
      if (req.query?.model && request.productName !== req.query.model) return false;
      if (req.query?.storage && request.storage !== req.query.storage) return false;
      return true;
    });

    const unitsSold = await unitsSoldBetween(from, to, { productName: req.query?.model });

    return res.status(200).json({
      window: { from, to },
      metrics: buildReturnMetrics({ requests: filtered, unitsSold }),
      byProduct: groupReturns(filtered, "productName"),
      byStorage: groupReturns(filtered, "storage"),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The same returns as a spreadsheet.
 *
 * One row per return, flat, with the fields somebody would actually pivot on.
 * Nested objects are flattened rather than JSON-stringified into a cell — a
 * cell containing {"type":"OPEN_BOX"} is not something anyone can filter.
 */
async function exportReturnsCsv(req, res, next) {
  try {
    const { from, to } = reportWindow(req.query);

    const requests = await RefundRequest.find({ createdAt: { $gte: from, $lte: to } })
      .select("rmaNumber status reasonCode reasonCategory faultAttribution createdAt resolution disposition refundBreakdown sla email")
      .sort({ createdAt: 1 })
      .lean();

    const rows = requests.map((request) => ({
      rma: request.rmaNumber || "",
      status: request.status,
      reason: request.reasonCode || "",
      category: request.reasonCategory || "",
      faultAttribution: request.faultAttribution || "",
      requestedAt: request.createdAt ? new Date(request.createdAt).toISOString() : "",
      settledAt: request.resolution?.settledAt
        ? new Date(request.resolution.settledAt).toISOString()
        : "",
      outcome: request.resolution?.outcome || "",
      settlementMethod: request.resolution?.settlementMethod || "",
      settlementAmount: request.resolution?.settlementAmount ?? "",
      disposition: request.disposition?.type || "",
      grade: request.disposition?.grade || "",
      dueAt: request.sla?.dueAt ? new Date(request.sla.dueAt).toISOString() : "",
    }));

    const csv = toCsv(rows);

    res.set("Content-Type", "text/csv; charset=utf-8");
    // Dated, because a file called returns.csv in a downloads folder is
    // indistinguishable from the last four.
    res.set(
      "Content-Disposition",
      `attachment; filename="upcell-returns-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`
    );
    return res.status(200).send(csv);
  } catch (error) {
    return next(error);
  }
}

/**
 * Moves the date the customer's 30 days started from.
 *
 * Needed because the record is sometimes wrong: a carrier marks a parcel
 * delivered when it reaches a depot, or never marks it at all, and the
 * customer has an email saying when it actually turned up. Staff can see that
 * and the system cannot.
 *
 * The note is not paperwork. This decides whether a return is inside the
 * window, so it moves money — and with two or three staff able to do it, an
 * unexplained override is indistinguishable from a favour.
 */
async function overrideReturnWindow(req, res, next) {
  try {
    const { startDate, note } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request)
      return res.status(404).json({ error: "Refund request not found" });

    const validation = validateOverride({
      startDate,
      note,
      by: req.user?.email || req.user?.id,
    });
    if (!validation.ok)
      return res.status(400).json({ error: validation.error });

    const order = await Order.findById(request.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const previous = request.window?.startDate;
    const window = resolveWindowStart(order, { override: validation.override });

    request.window = {
      startedFrom: window.startedFrom,
      startDate: window.startDate,
      expiresAt: window.expiresAt,
      overrideBy: window.overrideBy,
      overrideNote: window.overrideNote,
    };

    recordEvent(request, {
      event: "window_overridden",
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      meta: {
        from: previous,
        to: window.startDate,
        note: window.overrideNote,
      },
    });

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "refund_request.window_overridden",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { startDate: window.startDate, note: window.overrideNote },
    }).catch(() => {});

    return res.status(200).json({ ok: true, window: request.window });
  } catch (error) {
    return next(error);
  }
}

/**
 * Freezes a return's inspection photos, or lets them go.
 *
 * A chargeback, or a solicitor's letter, arrives long after the case looks
 * closed and the ninety days are nearly up. This is the switch that keeps the
 * evidence, and it outranks every other rule the purge applies.
 *
 * Nothing is deleted when the hold is lifted either — the photos simply become
 * eligible again on the next run, with their original purge dates intact.
 */
async function setDisputeHold(req, res, next) {
  try {
    const { disputed, reason } = req.body || {};

    const request = await RefundRequest.findById(req.params.id || null);
    if (!request)
      return res.status(404).json({ error: "Refund request not found" });

    const was = Boolean(request.disputed);
    if (was === Boolean(disputed)) {
      return res.status(200).json({ ok: true, disputed: was, unchanged: true });
    }

    request.disputed = Boolean(disputed);

    recordEvent(request, {
      event: disputed ? "dispute_hold_applied" : "dispute_hold_lifted",
      actor: req.user?.email || req.user?.id,
      actorType: "staff",
      meta: { reason: reason ? String(reason).trim() : undefined },
    });

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: disputed
        ? "refund_request.dispute_hold_applied"
        : "refund_request.dispute_hold_lifted",
      targetType: "RefundRequest",
      targetId: String(request._id),
      metadata: { reason },
    }).catch(() => {});

    return res.status(200).json({ ok: true, disputed: request.disputed });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getRefundableItems,
  createRefundRequest,
  getMyRefundRequests,
  getAdminRefundRequests,
  updateRefundRequestStatus,
  recordReturnLabel,
  lookupReturnRequest,
  getInspectionChecklist,
  submitInspection,
  offerRevisedRefund,
  respondToRevisedOffer,
  getRevisedOffer,
  settleRefundRequest,
  getReturnsDashboard,
  shipRejectedDeviceBack,
  markShipBackUndeliverable,
  getShipBackQueue,
  getDispositions,
  recordDisposition,
  getReturnsReport,
  exportReturnsCsv,
  overrideReturnWindow,
  setDisputeHold,
};
