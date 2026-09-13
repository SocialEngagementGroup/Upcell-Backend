// Getting a traded-in device from a customer's hand onto UpCell's shelf.
//
// This is the returns workflow run backwards, and it deliberately calls the
// same code: services/returnShipping.js records the parcels,
// services/returnInspection.js validates the checklist, services/
// revisedOffer.js builds an offer worth less than the quote. A second copy of
// any of those would drift, and the one that drifts is always the one nobody
// is looking at.
//
// One difference in meaning rather than in shape. On a return, the
// `imei_matches` check asks whether the device sent back is the device that was
// sold — there is a prior record to compare against. A trade-in has no such
// record, so the same check records the number for the first time. That is why
// the inspection here writes inspection.imei and the returns one does not.

const { TradeInRequest } = require("../models/tradeInRequest.model");
const SingleVariation = require("../models/singleVariation.model");
const AuditLog = require("../models/auditLog.model");
const tradeInStatus = require("../constants/tradeInStatus");
const { ACTIVE_STATUSES } = tradeInStatus;
const { applyTransition, recordEvent } = require("../services/returnTimeline");
const {
  validateShipment,
  trackingNumberInUse,
  recordInboundLeg,
  recordOutboundLeg,
  recordUndeliverable,
} = require("../services/returnShipping");
const {
  validateInspection,
  batteryHealthFrom,
  cosmeticGradeFrom,
  gradeFrom,
  suggestOutcome,
  stampPurgeDates,
} = require("../services/returnInspection");
const {
  buildRevisedOffer,
  offerExpiryFrom,
  offerHasExpired,
  OFFER_RESPONSE_DAYS,
} = require("../services/revisedOffer");
const { createAccessToken, hashToken, tokenMatchesHash } = require("../utils/accessToken");
const { quotedCents } = require("../services/tradeInReporting");

const actorOf = (req) => req.user?.email || req.user?.id || "system";

/**
 * Moves a request, or returns the refusal to send back.
 *
 * Wraps applyTransition only to save passing the trade-in map at nine call
 * sites — and so a new handler cannot forget it, which would silently check a
 * trade-in against the returns map and refuse every legal move.
 */
function moveStatus(request, to, options = {}) {
  return applyTransition(request, to, { ...options, machine: tradeInStatus });
}

const trackingClash = (clash) =>
  `That tracking number is already on another open trade-in${clash?._id ? ` (${String(clash._id).slice(-6)})` : ""}.`;

/**
 * POST /admin-trade-in-requests/:id/label
 *
 * Manual for now. A staff member buys the label in FedEx Ship Manager, uploads
 * it, and types the tracking number. When the FedEx API lands this is the one
 * function that changes — everything downstream reads the stored fields and
 * does not care which wrote them.
 */
async function recordTradeInLabel(req, res, next) {
  try {
    const { carrier, trackingNumber, labelUrl, labelCost } = req.body || {};

    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    const shipment = validateShipment({ carrier, trackingNumber, labelUrl });
    if (!shipment.ok) return res.status(400).json({ error: shipment.error });

    const clash = await trackingNumberInUse({
      Model: TradeInRequest,
      activeStatuses: ACTIVE_STATUSES,
      trackingNumber: shipment.trackingNumber,
      exceptId: request._id,
    });
    if (clash) return res.status(409).json({ error: trackingClash(clash) });

    recordInboundLeg(request, {
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      labelUrl: shipment.labelUrl,
      labelCost,
    });

    // UpCell wants the device, so UpCell pays to get it. Unlike a return,
    // where a change of mind is the customer's own cost, there is no version
    // of this where the customer pays postage — recordInboundLeg works that
    // out from faultAttribution, which a trade-in does not have, so it lands
    // on UPCELL. Written explicitly so that is a decision rather than a
    // side effect of a missing field.
    request.shipping.inbound.paidBy = "UPCELL";

    // Only moves when there is somewhere to move to. Re-uploading a corrected
    // label onto a request already at LabelIssued should replace the file, not
    // fail because the transition is illegal.
    if (request.status === "Quoted") {
      const moved = moveStatus(request, "LabelIssued", {
        actor: actorOf(req),
        actorType: "staff",
        meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
      });
      if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    } else {
      recordEvent(request, {
        event: "label_replaced",
        actor: actorOf(req),
        actorType: "staff",
        meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
      });
    }

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.label_issued",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
    }).catch(() => {});

    return res.status(200).json(request);
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /admin-trade-in-lookup?q=
 *
 * The receiving desk: somebody has a box in their hands and a number on it.
 *
 * Searches the tracking numbers and the IMEI, because a box turns up with a
 * label nobody can read often enough that "no match" has to have a second
 * thing to try.
 */
async function lookupTradeInRequest(req, res, next) {
  try {
    const term = String(req.query?.q || "").trim();
    if (term.length < 4) {
      return res.status(400).json({ error: "Enter a tracking number, an IMEI, or the last part of a request id." });
    }

    const normalised = term.toUpperCase();

    const request = await TradeInRequest.findOne({
      $or: [
        { "shipping.inbound.trackingNumber": normalised },
        { "shipping.outbound.trackingNumber": normalised },
        { "inspection.imei": term },
        { imei: term },
      ],
    }).lean();

    if (!request) {
      return res.status(404).json({
        error: "No trade-in found for that number.",
        // Said explicitly, because the wrong instinct here is to create one.
        hint: "Check the tracking number on the label, or the IMEI in Settings on the device. Do not create a new request for a parcel that has arrived.",
      });
    }

    return res.status(200).json({ ok: true, request });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /admin-trade-in-requests/:id/inspection
 *
 * What the device turned out to be.
 *
 * The outcome is suggested, never applied: a checklist cannot see a device, and
 * the person holding it can. What the code does decide is the grade, because
 * that is arithmetic over two axes and the rule that a battery drop is never
 * damage has to hold whoever is at the bench.
 */
async function submitTradeInInspection(req, res, next) {
  try {
    const { checklist = [], photos = [], findings, imei, serialNumber } = req.body || {};

    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    if (!["DeviceReceived", "InInspection", "ActionRequired"].includes(request.status)) {
      return res.status(400).json({
        error: `A device is inspected once it has arrived. This trade-in is ${request.status}.`,
      });
    }

    // context: "tradeIn" drops the one check that only means something for a
    // device UpCell sold — whether it still matches the grade it sold at.
    // See constants/inspectionChecklist.js.
    const checked = validateInspection({ checklist, photos, context: "tradeIn" });
    if (!checked.ok) {
      return res.status(400).json({ error: "This inspection is not complete.", details: checked.errors });
    }

    const now = new Date();

    request.inspection = {
      ...(request.inspection?.toObject?.() || request.inspection || {}),
      inspectorId: actorOf(req),
      startedAt: request.inspection?.startedAt || now,
      completedAt: now,
      checklist: checked.checklist,
      batteryHealth: batteryHealthFrom(checked.checklist),
      cosmeticGrade: cosmeticGradeFrom(checked.checklist),
      finalGrade: gradeFrom(checked.checklist),
      // Recorded here for the first time, not matched against anything. A
      // trade-in has no prior record of the device — this is the record.
      imei: imei ? String(imei).trim() : request.inspection?.imei,
      serialNumber: serialNumber ? String(serialNumber).trim() : request.inspection?.serialNumber,
      photos: stampPurgeDates(photos, now),
      findings,
    };

    const suggestion = suggestOutcome({ checklist: checked.checklist });

    // Into InInspection first, whatever the outcome turns out to be.
    //
    // The map has no DeviceReceived -> ActionRequired edge, and that is right
    // rather than a gap: a device cannot be blocked before anybody has looked
    // at it, and somebody has just looked at it. Recording the inspection and
    // then parking the device is also what actually happened, which is what
    // the timeline has to say.
    if (request.status !== "InInspection") {
      const moved = moveStatus(request, "InInspection", {
        actor: actorOf(req),
        actorType: "staff",
        event: "inspection_recorded",
        meta: { finalGrade: request.inspection.finalGrade, suggested: suggestion.outcome },
      });
      if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });
    } else {
      recordEvent(request, {
        event: "inspection_recorded",
        actor: actorOf(req),
        actorType: "staff",
        meta: { finalGrade: request.inspection.finalGrade, suggested: suggestion.outcome },
      });
    }

    // Activation Lock parks the device; it does not fail it. Only the customer
    // can clear it, and the payout clock stops while UpCell is waiting on them
    // rather than the other way round.
    if (suggestion.outcome === "ACTION_REQUIRED") {
      const blocked = moveStatus(request, "ActionRequired", {
        actor: actorOf(req),
        actorType: "staff",
        event: "inspection_blocked",
        meta: { reason: suggestion.reason },
      });
      if (!blocked.ok) return res.status(400).json({ error: blocked.error, allowed: blocked.allowed });

      request.sla = { ...(request.sla || {}), clockPausedAt: now };
      await request.save();

      return res.status(200).json({ ok: true, request, suggestion });
    }

    // The clock restarts from the end of inspection, not from when the device
    // arrived: a device that sat in a queue is UpCell's delay to own, and one
    // blocked on Activation Lock is not.
    request.sla = {
      ...(request.sla || {}),
      clockStartedAt: now,
      clockPausedAt: undefined,
    };

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.inspected",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: {
        finalGrade: request.inspection.finalGrade,
        batteryHealth: request.inspection.batteryHealth,
        suggested: suggestion.outcome,
        imei: request.inspection.imei,
      },
    }).catch(() => {});

    // Suggested, not applied. A checklist cannot see a device.
    return res.status(200).json({ ok: true, request, suggestion });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /admin-trade-in-requests/:id/revised-offer
 *
 * The device is worth less than the quote said. This is the offer, the reasons
 * for it, and a link the customer can answer without signing in.
 */
async function offerRevisedTradeIn(req, res, next) {
  try {
    const { deductions = [] } = req.body || {};

    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    const quoted = quotedCents(request);
    if (!Number.isFinite(quoted) || quoted <= 0) {
      return res.status(400).json({ error: "This trade-in has no quote to revise." });
    }

    // buildRevisedOffer works in the same unit it is given. Passed cents, so
    // every deduction is in cents and the offer comes back in cents — mixing
    // the two is how a $40 deduction becomes 40 cents.
    const offer = buildRevisedOffer({
      itemsTotal: quoted,
      deductions,
      checklist: request.inspection?.checklist || [],
    });

    if (!offer.ok) {
      return res.status(400).json({ error: "This offer cannot be sent.", details: offer.errors });
    }

    const moved = moveStatus(request, "RevisedOffer", {
      actor: actorOf(req),
      actorType: "staff",
      event: "revised_offer_sent",
      meta: { quotedCents: quoted, offeredCents: offer.offeredAmount },
    });
    if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });

    request.revisedOfferCents = offer.offeredAmount;
    request.offerDeductions = offer.deductions;
    request.offerExpiresAt = offerExpiryFrom();

    // A fresh token on every offer, and only its hash is stored. The plaintext
    // exists in this variable and in the email that carries it, nowhere else.
    //
    // That also decides the rotation question: a second offer mints a new
    // token and the link in the superseded email stops working. Two live links
    // to answer one offer is two ways to get a different answer, and the email
    // a customer should act on is the one with the current amount in it.
    const plainToken = createAccessToken();
    request.accessToken = hashToken(plainToken);

    // Waiting on the customer, so the clock stops.
    request.sla = { ...(request.sla || {}), clockPausedAt: new Date() };

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.revised_offer_sent",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: {
        quotedCents: quoted,
        offeredCents: offer.offeredAmount,
        deductions: offer.deductions,
      },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      request,
      // The only time the plaintext token leaves this function. The caller
      // puts it in the email; nothing stores it.
      offerToken: plainToken,
      respondByDays: OFFER_RESPONSE_DAYS,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /trade-ins/:id/offer?token=
 *
 * What the customer is being asked to answer. No login: an offer they cannot
 * open is an offer that expires and a device that gets posted back.
 */
async function getTradeInOffer(req, res, next) {
  try {
    const request = await TradeInRequest.findById(req.params.id || null).select("+accessToken");
    if (!request) return res.status(404).json({ error: "Offer not found." });

    if (!tokenMatchesHash(req.query?.token, request.accessToken)) {
      // 404, not 403. Confirming that an id is real is itself worth knowing to
      // whoever is guessing them.
      return res.status(404).json({ error: "Offer not found." });
    }

    if (request.status !== "RevisedOffer") {
      return res.status(200).json({
        ok: false,
        reason: "already_answered",
        message: "This offer has already been answered. Nothing further is needed from you.",
        status: request.status,
      });
    }

    if (offerHasExpired(request)) {
      return res.status(200).json({
        ok: false,
        reason: "expired",
        message: "This offer has expired. Get in touch and we will look at it again.",
      });
    }

    // An allowlist. The customer needs the amount, the reasons and the
    // deadline; they do not need the inspector's id or the audit trail.
    return res.status(200).json({
      ok: true,
      modelTitle: request.modelTitle,
      quotedCents: quotedCents(request),
      offeredCents: request.revisedOfferCents,
      deductions: (request.offerDeductions || []).map((line) => ({
        type: line.type,
        amount: line.amount,
        reason: line.reason,
      })),
      expiresAt: request.offerExpiresAt,
      finalGrade: request.inspection?.finalGrade,
      batteryHealth: request.inspection?.batteryHealth,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /trade-ins/:id/:decision
 *
 * accept or decline. Single-use: the token is cleared either way, so a
 * forwarded email cannot be used to change an answer already given.
 */
async function respondToTradeInOffer(req, res, next) {
  try {
    const decision = String(req.params.decision || "").toLowerCase();
    if (!["accept", "decline"].includes(decision)) {
      return res.status(400).json({ error: "The decision must be accept or decline." });
    }

    const request = await TradeInRequest.findById(req.params.id || null).select("+accessToken");
    if (!request) return res.status(404).json({ error: "Offer not found." });

    if (!tokenMatchesHash(req.body?.token || req.query?.token, request.accessToken)) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (request.status !== "RevisedOffer") {
      return res.status(400).json({
        error: "This offer has already been answered.",
        status: request.status,
      });
    }

    if (offerHasExpired(request)) {
      return res.status(400).json({ error: "This offer has expired. Get in touch and we will look at it again." });
    }

    const accepted = decision === "accept";

    const moved = moveStatus(request, accepted ? "Approved" : "Rejected", {
      actor: request.email,
      actorType: "customer",
      event: accepted ? "revised_offer_accepted" : "revised_offer_declined",
      meta: { offeredCents: request.revisedOfferCents },
    });
    if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });

    // Single-use. A forwarded email must not be able to change an answer
    // already given, and the answer is the one thing here that cannot be
    // undone by a person later.
    request.accessToken = undefined;

    if (accepted) {
      // The clock runs again: UpCell owes money and the delay from here is
      // UpCell's.
      request.sla = { ...(request.sla || {}), clockPausedAt: undefined, clockStartedAt: new Date() };
    }

    await request.save();

    AuditLog.create({
      actorId: null,
      actorEmail: request.email,
      action: accepted ? "trade_in.offer_accepted" : "trade_in.offer_declined",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: { offeredCents: request.revisedOfferCents },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: request.status,
      message: accepted
        ? "Thanks — we will send your payment shortly."
        : "No problem. We will post the device back to you at our cost.",
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /admin-trade-in-requests/:id/ship-back
 *
 * A refused device going home. UpCell pays, rather than holding a device while
 * an already-disappointed customer decides whether to pay $12 for it.
 */
async function shipTradeInBack(req, res, next) {
  try {
    const { carrier, trackingNumber, labelUrl, labelCost } = req.body || {};

    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    if (request.status !== "Rejected") {
      return res.status(400).json({
        error: `Only a refused trade-in is sent back. This one is ${request.status}.`,
      });
    }

    const shipment = validateShipment({ carrier, trackingNumber, labelUrl });
    if (!shipment.ok) return res.status(400).json({ error: shipment.error });

    const clash = await trackingNumberInUse({
      Model: TradeInRequest,
      activeStatuses: ACTIVE_STATUSES,
      trackingNumber: shipment.trackingNumber,
      exceptId: request._id,
    });
    if (clash) return res.status(409).json({ error: trackingClash(clash) });

    recordOutboundLeg(request, {
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      labelUrl: shipment.labelUrl,
      labelCost,
    });

    const moved = moveStatus(request, "ReturnShipped", {
      actor: actorOf(req),
      actorType: "staff",
      event: "shipped_back",
      meta: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
    });
    if (!moved.ok) return res.status(400).json({ error: moved.error, allowed: moved.allowed });

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.shipped_back",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
    }).catch(() => {});

    return res.status(200).json(request);
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /admin-trade-in-requests/:id/undeliverable
 *
 * The device came back again. Starts a hold rather than disposing of anything:
 * a customer who moved house or was away should get an email, not a
 * written-off phone.
 */
async function markTradeInUndeliverable(req, res, next) {
  try {
    const { reason } = req.body || {};

    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    if (!request.shipping?.outbound?.shippedAt) {
      return res.status(400).json({
        error: "This device has not been sent back, so it cannot have come back undelivered.",
      });
    }

    recordUndeliverable(request, { reason: String(reason || "").trim() || undefined });

    recordEvent(request, {
      event: "ship_back_undeliverable",
      actor: actorOf(req),
      actorType: "staff",
      meta: { reason, disposeAfter: request.shipping.outbound.disposeAfter },
    });

    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.ship_back_undeliverable",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: { reason, disposeAfter: request.shipping.outbound.disposeAfter },
    }).catch(() => {});

    return res.status(200).json(request);
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /admin-trade-in-requests/:id/list
 *
 * Turns an agreed trade-in into a catalogue row somebody can price.
 *
 * Created out of stock and with no price on purpose. A device that appears in
 * the shop the moment it is accepted is a device offered for sale before
 * anybody decided what it is worth — and the price book that quoted the buy
 * says nothing about the sell. A person opens it in Add Product, sets a price,
 * and puts it on the shelf.
 */
async function listTradedDevice(req, res, next) {
  try {
    const request = await TradeInRequest.findById(req.params.id || null);
    if (!request) return res.status(404).json({ error: "Trade-in request not found" });

    if (!["Approved", "Paid"].includes(request.status)) {
      return res.status(400).json({
        error: `A device is listed once the trade-in is agreed. This one is ${request.status}.`,
      });
    }

    if (request.listedVariationId) {
      return res.status(409).json({
        error: "This device is already in the catalogue.",
        variationId: request.listedVariationId,
      });
    }

    const grade = request.inspection?.finalGrade;
    if (grade === "FAIL") {
      return res.status(400).json({
        error: "A device that failed inspection is not listed. Decide what happens to it instead.",
      });
    }

    const variation = await SingleVariation.create({
      productName: request.modelTitle || request.model,
      storage: request.storage,
      // No price. Somebody has to decide what it sells for, and the price book
      // that quoted the buy says nothing about the sell.
      price: undefined,
      cosmeticGrade: grade,
      batteryHealth: request.inspection?.batteryHealth,
      imei: request.inspection?.imei || undefined,
      serialNumber: request.inspection?.serialNumber || undefined,
      // Bought from a member of the public, which means there is nobody to
      // return it to if it fails later. That is what closes the supplier
      // route on any future return of this exact unit.
      acquisitionSource: "INDIVIDUAL",
      // Off the shelf until a person has priced it and chosen a photo.
      outOfStock: true,
      refurbState: request.inspection?.batteryHealth != null && request.inspection.batteryHealth < 80
        ? "NEEDS_BATTERY"
        : "SELLABLE",
    });

    request.listedVariationId = variation._id;
    recordEvent(request, {
      event: "device_listed",
      actor: actorOf(req),
      actorType: "staff",
      meta: { variationId: String(variation._id), grade },
    });
    await request.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "trade_in.device_listed",
      targetType: "TradeInRequest",
      targetId: request._id,
      metadata: { variationId: String(variation._id), grade, imei: request.inspection?.imei },
    }).catch(() => {});

    return res.status(201).json({
      ok: true,
      variationId: variation._id,
      // Said plainly, because a draft nobody finishes is a device that never
      // goes on sale.
      message: "Added to the catalogue as a draft. Set a price and a photo in Add Product to list it.",
    });
  } catch (error) {
    // The unique index rejected an IMEI already in the catalogue. That is a
    // real answer, not a crash: the same physical device cannot be listed
    // twice, and one traded in twice means somebody bought it back.
    if (error?.code === 11000) {
      return res.status(409).json({
        error: "A device with that IMEI or serial is already in the catalogue. Find that unit rather than adding a second one.",
      });
    }
    return next(error);
  }
}

module.exports = {
  recordTradeInLabel,
  lookupTradeInRequest,
  submitTradeInInspection,
  offerRevisedTradeIn,
  getTradeInOffer,
  respondToTradeInOffer,
  shipTradeInBack,
  markTradeInUndeliverable,
  listTradedDevice,
  moveStatus,
};
