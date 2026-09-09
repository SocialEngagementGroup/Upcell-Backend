// Recording where a returned device went, and putting it back on sale when
// that is what it deserves.
//
// Only a sealed device restocks automatically. Everything else produces a
// record for a person to act on — automatically listing an opened phone as new
// is exactly the mistake the disposition model exists to prevent, and no
// checklist answer is worth trusting that far.

const { isDisposition, restocks, REQUIRES_REASON, DISPOSITIONS } = require("../constants/dispositions");

/**
 * Whether this disposition can be recorded.
 *
 * The grade and the IMEI are demanded for anything that is not going straight
 * back on sale, because those are the two things whoever handles it next needs
 * and neither can be recovered once the device has left the bench.
 */
function validateDisposition({ type, reason, grade, imei }) {
  if (!isDisposition(type)) {
    return { ok: false, error: `"${type}" is not a disposition.` };
  }

  if (REQUIRES_REASON.includes(type) && !String(reason || "").trim()) {
    return {
      ok: false,
      error: type === "SCRAP"
        // A device that vanishes without one is indistinguishable from a device
        // that walked.
        ? "Writing a device off needs a reason."
        : "Say which supplier terms this is going back under.",
    };
  }

  if (!restocks(type) && !String(grade || "").trim()) {
    return {
      ok: false,
      error: "A device leaving the returns queue needs its grade, so whoever handles it next knows what they have.",
    };
  }

  return {
    ok: true,
    disposition: {
      type,
      grade: grade ? String(grade).trim() : undefined,
      reason: reason ? String(reason).trim() : undefined,
      imei: imei ? String(imei).trim() : undefined,
    },
  };
}

/**
 * Puts a device back into sellable stock.
 *
 * The exact inverse of markSold in services/inventory.js: every device is a
 * single unit, so selling one sets outOfStock and restocking one clears it,
 * along with any stale reservation left over from the checkout that sold it.
 *
 * Refuses on anything but RESTOCK_NEW rather than trusting the caller. This
 * function is one line away from listing a scrapped phone as new.
 */
async function restockDevice({ SingleVariation, productId, dispositionType }) {
  if (!restocks(dispositionType)) {
    return { ok: false, error: `${dispositionType} does not return a device to sale.` };
  }

  if (!productId) return { ok: false, error: "No product to restock." };

  const result = await SingleVariation.updateOne(
    // Devices only, matching how they are taken off sale. Restocking an
    // accessory would be meaningless — they are not single units.
    { _id: productId, isAccessory: { $ne: true } },
    { $set: { outOfStock: false, reservedUntil: null, reservedFor: null } }
  );

  if (!result.modifiedCount) {
    // Already on sale, or the product was deleted while the return was in
    // flight. Reported rather than thrown: the disposition is still worth
    // recording, and a staff member needs to know the shelf did not change.
    return { ok: false, error: "That product could not be put back on sale — check it still exists." };
  }

  return { ok: true };
}

/**
 * The line an internal inventory record needs.
 *
 * Not a new collection in v1. The plan is explicit that everything except
 * RESTOCK_NEW creates a record a human acts on, and the request itself already
 * carries the grade, the IMEI and the reason — a separate table would be a
 * second place for the same facts to go stale.
 */
function internalRecordFor(request, disposition) {
  return {
    rmaNumber: request.rmaNumber,
    disposition: disposition.type,
    label: DISPOSITIONS[disposition.type]?.label,
    grade: disposition.grade || request.inspection?.grade,
    imei: disposition.imei || request.device?.imei,
    reason: disposition.reason,
    productId: request.itemIds?.[0],
    decidedAt: new Date(),
  };
}

module.exports = { validateDisposition, restockDevice, internalRecordFor };
