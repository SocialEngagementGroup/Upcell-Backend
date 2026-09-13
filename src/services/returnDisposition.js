// Recording where a returned device went, and putting it back on sale when
// that is what it deserves.
//
// Every unit is its own catalogue record, so relisting is a status flip on one
// document — not stock arithmetic. That also makes the dangerous mistake
// specific and easy to name: touching the wrong document. Every write here is
// filtered by the exact _id the return was for, and nothing in this file can
// write to more than one.

const {
  isDisposition,
  relists,
  reprices,
  sourceAllows,
  REQUIRES_REASON,
  DISPOSITIONS,
} = require("../constants/dispositions");
const { GRADES } = require("../constants/grading");

/**
 * Whether this disposition can be recorded.
 *
 * The grade is demanded for anything leaving the returns queue, because that
 * is what whoever handles it next needs and it cannot be recovered once the
 * device has left the bench. A re-grade also needs a price: the system knows
 * the device dropped from Excellent to Good, but not what a Good one of these
 * is worth this month.
 */
function validateDisposition({ type, reason, grade, imei, price, acquisitionSource }) {
  if (!isDisposition(type)) {
    return { ok: false, error: `"${type}" is not a disposition.` };
  }

  const allowed = sourceAllows(type, acquisitionSource);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  if (REQUIRES_REASON.includes(type) && !String(reason || "").trim()) {
    return {
      ok: false,
      error: type === "SCRAP"
        // A device that vanishes without one is indistinguishable from a
        // device that walked.
        ? "Writing a device off needs a reason."
        : "Say which supplier terms this is going back under.",
    };
  }

  if (!String(grade || "").trim()) {
    return {
      ok: false,
      error: "A device leaving inspection needs its grade, so whoever handles it next knows what they have.",
    };
  }

  if (!Object.values(GRADES).includes(grade)) {
    return { ok: false, error: `Grade must be one of: ${Object.values(GRADES).join(", ")}.` };
  }

  if (reprices(type)) {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        error: "A re-graded device needs a new price — the grade dropped, so the listing cannot go back up at the old one.",
      };
    }
  }

  return {
    ok: true,
    disposition: {
      type,
      grade,
      reason: reason ? String(reason).trim() : undefined,
      imei: imei ? String(imei).trim() : undefined,
      price: reprices(type) ? Math.round(Number(price) * 100) / 100 : undefined,
    },
  };
}

/**
 * Puts one unit back on sale.
 *
 * Filtered by the exact _id and by nothing else, so this cannot reach another
 * unit's listing however it is called. That is the failure worth designing
 * against here: with per-unit records, a filter that matched a model or a
 * grade rather than an id would relist a shelf of devices that are not back.
 *
 * A re-graded unit gets its new grade and price in the same write, because a
 * listing that is live at the old price for even a moment is a listing
 * somebody can buy.
 */
async function relistDevice({ SingleVariation, productId, disposition }) {
  if (!relists(disposition?.type)) {
    return { ok: false, error: `${disposition?.type} does not put a device back on sale.` };
  }

  if (!productId) return { ok: false, error: "No unit to relist." };

  const update = {
    outOfStock: false,
    // Any hold left by the checkout that sold it.
    reservedUntil: null,
    reservedFor: null,
    cosmeticGrade: disposition.grade,
  };

  if (reprices(disposition.type)) {
    update.price = disposition.price;
  }

  const result = await SingleVariation.updateOne(
    // One id, and devices only. An accessory is not a single unit and has no
    // listing to reactivate.
    { _id: productId, isAccessory: { $ne: true } },
    { $set: update }
  );

  if (!result.modifiedCount) {
    // Already on sale, or the unit was deleted while the return was in flight.
    // Reported rather than thrown: the disposition is still worth recording,
    // and a staff member needs to know the shelf did not change.
    return { ok: false, error: "That unit could not be put back on sale — check it still exists." };
  }

  return { ok: true, relisted: true, repriced: reprices(disposition.type) };
}

/**
 * The line an internal record needs for a device that is not going back on
 * sale.
 *
 * Not a new collection. The request already carries the grade, the IMEI and
 * the reason, and a second table is a second place for the same facts to go
 * stale.
 */
function internalRecordFor(request, disposition) {
  return {
    rmaNumber: request.rmaNumber,
    disposition: disposition.type,
    label: DISPOSITIONS[disposition.type]?.label,
    grade: disposition.grade || request.inspection?.finalGrade,
    imei: disposition.imei || request.device?.imei,
    reason: disposition.reason,
    productId: request.itemIds?.[0],
    decidedAt: new Date(),
  };
}

module.exports = { validateDisposition, relistDevice, internalRecordFor };
