const Order = require("../models/order.model");
const PaymentEventLog = require("../models/paymentEventLog.model");
const { sendOpsAlert } = require("./alertService");
const { logPaymentEvent } = require("../controllers/checkout.controller");

// The safety net. Until now nothing checked whether what the bank did matches
// what the shop recorded — a payment taken with no order behind it would have
// sat undiscovered forever, because every failure path answers the bank 200
// and writes a log line nobody reads.
//
// Scope, stated honestly: this compares our own records against each other.
// Comparing against the bank's ledger needs the CyberSource Reporting API and
// a second set of credentials we do not have. That is the stronger check and
// worth adding once those keys exist. Everything below still catches the cases
// that actually lose money, because each one leaves a trace on our side.

const HOUR = 60 * 60 * 1000;

// How long an order may sit unpaid after the bank replied about it before that
// counts as stuck. A confirmation is processed in milliseconds, so anything
// still pending an hour later did not finish.
const STUCK_AFTER_MS = 1 * HOUR;

// Orders never confirmed at all. These are almost always abandoned carts — the
// customer closed the tab at the bank's page. Reported as information, not as
// an alarm, so real problems stay visible.
//
// 12 hours rather than a full day: the point of counting these is to notice a
// sudden jump, because that means the payment page itself has broken. Waiting
// until tomorrow to find out that nobody could pay today defeats the purpose.
const ABANDONED_AFTER_MS = 12 * HOUR;

const money = (value) => `$${Number(value || 0).toFixed(2)}`;
const orderTotal = (order) =>
  (order?.line_items || []).reduce(
    (sum, item) => sum + (item?.price_data?.product_data?.metadata?.totalPaid || 0),
    0
  );

/**
 * Close checkouts the customer started and walked away from, so they stop
 * sitting in the order list looking like real orders.
 *
 * The safety condition is the important part: only orders the bank has never
 * said anything about are touched. If any payment event exists for an order,
 * the bank did reply and something went wrong on our side — auto-marking that
 * one "payment failed" could bury a real payment, which is the exact failure
 * this whole service exists to prevent. Those stay pending and are reported as
 * critical above, for a person to resolve.
 */
async function sweepAbandonedCheckouts() {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);

  const candidates = await Order.find({
    paidWith: "BankOfAmerica",
    status: "pending_payment",
    paid: false,
    createdAt: { $lte: cutoff },
  })
    .select("_id")
    .lean();

  if (!candidates.length) return 0;

  const ids = candidates.map((order) => order._id);

  // Any event at all — even a rejected signature — means the bank was involved.
  const spokenFor = await PaymentEventLog.find({ orderId: { $in: ids } })
    .select("orderId")
    .lean();

  const heardAbout = new Set(spokenFor.map((event) => String(event.orderId)));
  const safeToClose = ids.filter((id) => !heardAbout.has(String(id)));

  if (!safeToClose.length) return 0;

  const result = await Order.updateMany(
    { _id: { $in: safeToClose }, status: "pending_payment", paid: false },
    { $set: { status: "payment failed" } }
  );

  return result.modifiedCount || 0;
}

// How long an order may sit under review before it is closed automatically.
// One full business day: long enough that a review opened late on a Friday
// afternoon is still there on Monday morning for a person to answer, short
// enough that a customer is not left indefinitely unsure whether they have
// bought something. Deliberately unrelated to the stock hold, which is twenty
// minutes and never waits for a human.
const REVIEW_PENDING_MS = 24 * HOUR;

/**
 * Close reviews nobody answered inside the pending window.
 *
 * The honest limit, stated rather than hidden: this does NOT get the money
 * back. Secure Acceptance keys can take a payment and can never return one, so
 * an authorisation that was placed and then auto-rejected still has to be
 * reversed by hand in the Business Center. The code marks the order and says
 * so; it must not imply the customer has been released.
 *
 * Nothing is released here either — the devices went back on sale twenty
 * minutes after checkout, like every other hold.
 */
async function expireStaleReviews() {
  const cutoff = new Date(Date.now() - REVIEW_PENDING_MS);

  const stale = await Order.find({
    paidWith: "BankOfAmerica",
    status: "under_review",
    updatedAt: { $lte: cutoff },
  }).lean();

  if (!stale.length) return { closed: 0, lines: [] };

  const ids = stale.map((order) => order._id);

  const result = await Order.updateMany(
    { _id: { $in: ids }, status: "under_review" },
    { $set: { status: "payment failed", paid: false, reviewAutoRejectedAt: new Date() } }
  );

  for (const order of stale) {
    logPaymentEvent({
      gateway: "BankOfAmerica",
      eventType: "review_auto_rejected",
      orderId: order._id,
      gatewayReference: order.boaTransactionId,
      metadata: { waitedHours: Math.floor((Date.now() - new Date(order.updatedAt).getTime()) / HOUR) },
    });
  }

  const lines = stale.map(
    (order) =>
      `Order ${order._id} (${order.email}, ${money(orderTotal(order))}) — review never ` +
      `answered, closed automatically. Transaction ${order.boaTransactionId || "unknown"} ` +
      `may still be authorised: reverse it by hand in the Business Center.`
  );

  return { closed: result.modifiedCount || 0, lines };
}

/**
 * Look for payment records that disagree with each other.
 * Returns a report; never throws, so a scheduled run cannot take the app down.
 */
async function runReconciliation({ windowMs = 24 * HOUR } = {}) {
  const since = new Date(Date.now() - windowMs);
  const critical = [];
  const warnings = [];
  const info = [];

  try {
    // 1. The bank confirmed a payment we could not tie to an order. Money may
    //    have moved with nothing in the shop to show for it.
    const unmatched = await PaymentEventLog.find({
      eventType: "unmatched_confirmation",
      createdAt: { $gte: since },
    }).lean();

    for (const event of unmatched) {
      critical.push(
        `Bank confirmed a payment we cannot match to an order. ` +
          `Transaction ${event.gatewayReference || "unknown"}, ` +
          `reason: ${event.metadata?.reason || "unknown"}`
      );
    }

    // 2. The bank authorised an amount that is not what the order is worth.
    const mismatches = await PaymentEventLog.find({
      eventType: "amount_mismatch",
      createdAt: { $gte: since },
    }).lean();

    for (const event of mismatches) {
      critical.push(
        `Amount mismatch on order ${event.orderId}: expected ` +
          `${money(event.metadata?.expected)}, bank authorised ` +
          `${money(event.metadata?.authorised)}. Not marked paid.`
      );
    }

    // 3. We heard from the bank about an order, but it never reached a settled
    //    state. This is the shape the req_reference_number bug produced, and
    //    the check that would have caught it on day one.
    const replied = await PaymentEventLog.find({
      eventType: "webhook_received",
      createdAt: { $gte: since, $lte: new Date(Date.now() - STUCK_AFTER_MS) },
    }).lean();

    const repliedIds = [
      ...new Set(
        replied
          .map((e) => e.metadata?.reference_number)
          .filter((id) => /^[0-9a-fA-F]{24}$/.test(id || ""))
      ),
    ];

    if (repliedIds.length) {
      const stuck = await Order.find({
        _id: { $in: repliedIds },
        status: "pending_payment",
      }).lean();

      for (const order of stuck) {
        critical.push(
          `Order ${order._id} (${order.email}, ${money(orderTotal(order))}) — ` +
            `the bank replied but the order is still pending. Check the ` +
            `Business Center before assuming no money moved.`
        );
      }
    }

    // 4. Close any review that outlived its pending window, then report the
    //    ones still open. Order matters: sweeping first means a review that
    //    just expired is reported as closed rather than as still waiting.
    const expired = await expireStaleReviews();
    for (const line of expired.lines) critical.push(line);

    // 5. Payments the bank is still reviewing by hand. Their devices are NOT
    //    held — the ordinary twenty-minute hold applies and has almost
    //    certainly expired — so every hour one of these stays open is an hour
    //    the device can sell to somebody else and leave a paid order with
    //    nothing to ship. Naming them is what keeps that window short.
    const underReview = await Order.find({
      paidWith: "BankOfAmerica",
      status: "under_review",
    }).lean();

    for (const order of underReview) {
      const waitingHours = Math.floor((Date.now() - new Date(order.updatedAt).getTime()) / HOUR);
      warnings.push(
        `Order ${order._id} (${order.email}, ${money(orderTotal(order))}) has been ` +
          `under review at the bank for ${waitingHours} hour${waitingHours === 1 ? "" : "s"}. ` +
          `Its devices are back on sale — resolve it in the Business Center before ` +
          `someone else buys them.`
      );
    }

    // 6. Paid, but nothing to ship. The oversell collision the twenty-minute
    //    rule accepts as its cost — money taken and the device already gone.
    const blocked = await Order.find({
      paidWith: "BankOfAmerica",
      fulfilmentBlocked: true,
      createdAt: { $gte: since },
    }).lean();

    for (const order of blocked) {
      critical.push(
        `Order ${order._id} (${order.email}, ${money(orderTotal(order))}) is paid but ` +
          `cannot be fulfilled: ${order.fulfilmentBlockReason || "device unavailable"}`
      );
    }

    // 7. Marked paid with no transaction id. Nothing can be refunded or
    //    disputed without that reference.
    const paidWithoutReference = await Order.find({
      paidWith: "BankOfAmerica",
      paid: true,
      createdAt: { $gte: since },
      $or: [{ boaTransactionId: { $exists: false } }, { boaTransactionId: null }, { boaTransactionId: "" }],
    }).lean();

    for (const order of paidWithoutReference) {
      warnings.push(
        `Order ${order._id} is marked paid but has no bank transaction id — ` +
          `it cannot be refunded from the Business Center.`
      );
    }

    // 8. Abandoned checkouts. Expected and harmless; counted so a sudden jump
    //    is visible, because that usually means the payment page is broken.
    const abandoned = await Order.countDocuments({
      paidWith: "BankOfAmerica",
      status: "pending_payment",
      createdAt: { $gte: since, $lte: new Date(Date.now() - ABANDONED_AFTER_MS) },
    });

    if (abandoned > 0) {
      info.push(`${abandoned} checkout${abandoned === 1 ? "" : "s"} started but never completed.`);
    }

    // Tidying up must never cost us the findings. The sweep is the only part
    // of this service that writes, so it is the only part that can fail in a
    // new way — and if it did, sharing the outer catch meant every problem
    // found above was discarded with it. Its own catch keeps the report.
    try {
      const swept = await sweepAbandonedCheckouts();
      if (swept > 0) {
        info.push(`${swept} abandoned checkout${swept === 1 ? "" : "s"} closed automatically.`);
      }
    } catch (error) {
      console.error("[reconciliation] closing abandoned checkouts failed:", error);
      warnings.push("Could not close abandoned checkouts: " + error.message);
    }
  } catch (error) {
    console.error("[reconciliation] check failed:", error);
    return { ok: false, error: error.message, critical, warnings, info, checkedAt: new Date() };
  }

  const report = {
    ok: true,
    checkedAt: new Date(),
    windowHours: Math.round(windowMs / HOUR),
    critical,
    warnings,
    info,
    clean: critical.length === 0 && warnings.length === 0,
  };

  if (critical.length || warnings.length) {
    await sendOpsAlert({
      kind: "payment_reconciliation",
      title: critical.length
        ? `${critical.length} payment problem${critical.length === 1 ? "" : "s"} need checking`
        : `${warnings.length} payment warning${warnings.length === 1 ? "" : "s"}`,
      summary: critical.length
        ? "The daily payment check found records that do not agree. Money may be involved — please look today."
        : "The daily payment check found something worth a look. Not urgent.",
      lines: [...critical, ...warnings],
      // Anything critical bypasses the throttle. A payment problem silenced by
      // an unrelated burst of errors is the exact failure this exists to stop.
      urgent: critical.length > 0,
    });
  }

  return report;
}

module.exports = { runReconciliation };
