// Recording the parcels, in both directions.
//
// Phase 1 is deliberately manual: a staff member buys the label in FedEx Ship
// Manager, uploads it, and types the tracking number. Phase 2 (R.14) generates
// the same fields from the FedEx API. Everything downstream — the emails, the
// receiving lookup, the tracking page — reads these fields and does not care
// which of the two wrote them, so the API work replaces one function rather
// than rippling through the workflow.
//
// Built as a service rather than inside the returns controller because trade-in
// intake will need the same shipping legs later, and the plan is explicit that
// it should call this code rather than grow a second copy.

// Carriers UpCell actually ships with. FedEx both ways per the plan; the others
// are here because a customer occasionally posts something back themselves and
// staff need somewhere to record it truthfully.
const CARRIERS = ["FedEx", "UPS", "USPS", "DHL", "Other"];

// Loose on purpose. Carriers use different lengths and formats, and a strict
// pattern rejects a real tracking number the moment one of them changes theirs
// — which strands a real parcel to prevent a typo. Length and character class
// catch the mistakes that actually happen: an empty box, or a pasted URL.
const TRACKING_PATTERN = /^[A-Za-z0-9-]{6,40}$/;

const normaliseTracking = (value) => String(value || "").trim().toUpperCase();

function validateShipment({ carrier, trackingNumber, labelUrl }) {
  if (!CARRIERS.includes(carrier)) {
    return { ok: false, error: `Carrier must be one of: ${CARRIERS.join(", ")}.` };
  }

  const tracking = normaliseTracking(trackingNumber);
  if (!TRACKING_PATTERN.test(tracking)) {
    return {
      ok: false,
      error: "Enter the tracking number as the carrier shows it — letters, numbers and dashes only.",
    };
  }

  // A label the customer cannot open is the same as no label: they wait for an
  // email that never usefully arrives, then email support.
  if (labelUrl && !/^https:\/\//i.test(String(labelUrl))) {
    return { ok: false, error: "The label link must be an https URL." };
  }

  return { ok: true, carrier, trackingNumber: tracking, labelUrl: labelUrl || undefined };
}

/**
 * Whether this tracking number is already on another live return.
 *
 * Two open returns sharing a tracking number means the receiving desk scans a
 * parcel and gets two answers, and a carrier update advances the wrong one. A
 * closed return can keep its number — reusing a number from two years ago is
 * the carrier's business, not ours.
 *
 * @param {object} deps
 * @param {object} deps.RefundRequest
 * @param {string[]} deps.activeStatuses
 * @param {string} [deps.exceptId]  the request being edited, so correcting a
 *                                  typo on the same request is not a clash
 */
async function trackingNumberInUse({ RefundRequest, activeStatuses, trackingNumber, exceptId }) {
  const tracking = normaliseTracking(trackingNumber);

  const clash = await RefundRequest.findOne({
    status: { $in: activeStatuses },
    $or: [
      { "shipping.inbound.trackingNumber": tracking },
      { "shipping.outbound.trackingNumber": tracking },
    ],
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select("_id rmaNumber")
    .lean();

  return clash || null;
}

/**
 * Writes one leg onto a request. Does not save.
 *
 * `paidBy` follows fault, not choice: a customer who changed their mind pays to
 * send it back, and UpCell pays for everything that was its own doing, plus
 * every ship-back of a rejected device.
 */
function recordInboundLeg(request, { carrier, trackingNumber, labelUrl, labelCost, now = new Date() }) {
  request.shipping = request.shipping || {};
  request.shipping.inbound = {
    ...(request.shipping.inbound || {}),
    carrier,
    trackingNumber: normaliseTracking(trackingNumber),
    labelUrl,
    labelCost,
    paidBy: request.faultAttribution === "CUSTOMER" ? "CUSTOMER" : "UPCELL",
    // Not shippedAt — the label existing is not the parcel moving. That is set
    // when the carrier first reports it, or when staff see it has moved.
    ...(request.shipping.inbound?.shippedAt ? {} : {}),
  };

  request.shipping.inbound.issuedAt = now;
  return request.shipping.inbound;
}

function recordOutboundLeg(request, { carrier, trackingNumber, labelUrl, labelCost, now = new Date() }) {
  request.shipping = request.shipping || {};
  request.shipping.outbound = {
    ...(request.shipping.outbound || {}),
    carrier,
    trackingNumber: normaliseTracking(trackingNumber),
    labelUrl,
    labelCost,
    // UpCell absorbs the ship-back on a rejection rather than holding the
    // device while an already-unhappy customer decides whether to pay $12.
    paidBy: "UPCELL",
    shippedAt: now,
  };

  return request.shipping.outbound;
}

// How long UpCell holds a device the customer would not take back.
//
// Refused or undeliverable parcels come back and then sit. Sixty days is long
// enough for someone who moved house or was away, and short enough that UpCell
// is not warehousing devices it can neither sell nor deliver. Stated on the
// returns page, so disposal at the end of it is not a surprise.
const UNDELIVERABLE_HOLD_DAYS = 60;

/**
 * Marks a ship-back as having come back.
 *
 * Starts the clock rather than disposing of anything. Disposal is a decision a
 * person makes with the record in front of them, and the escalation before it
 * is the point — a customer who missed a delivery should get an email, not a
 * written-off phone.
 */
function recordUndeliverable(request, { reason, now = new Date() } = {}) {
  request.shipping = request.shipping || {};
  request.shipping.outbound = {
    ...(request.shipping.outbound || {}),
    undeliverableAt: now,
    undeliverableReason: reason,
    disposeAfter: new Date(now.getTime() + UNDELIVERABLE_HOLD_DAYS * 24 * 60 * 60 * 1000),
  };

  return request.shipping.outbound;
}

/**
 * Whether a rejected device still has to be sent back.
 *
 * A rejected return cannot close while UpCell is still holding the device: that
 * is how a phone ends up on a shelf with nobody responsible for it and a
 * customer who has stopped being told anything.
 */
function awaitingShipBack(request) {
  if (request?.status !== "Rejected") return false;
  return !request?.shipping?.outbound?.shippedAt;
}

module.exports = {
  CARRIERS,
  UNDELIVERABLE_HOLD_DAYS,
  recordUndeliverable,
  awaitingShipBack,
  validateShipment,
  trackingNumberInUse,
  recordInboundLeg,
  recordOutboundLeg,
  normaliseTracking,
};
