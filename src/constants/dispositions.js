// Where a returned device goes once UpCell has decided to accept it.
//
// This is the answer to "what happens to the phone now". Without it an
// accepted return ends at the refund and the device becomes something on a
// shelf that nobody is responsible for — which is why a return cannot close
// until one of these has been chosen.
//
// UpCell sells used devices, and every unit is its own catalogue record with
// its own IMEI, grade and price. That makes the common case simple in a way it
// would not be for new stock: a device that comes back looking the way it left
// goes straight back onto its own listing with a status flip. There is no
// stock arithmetic and no "opened means devalued" problem, because it was
// never sealed.

const DISPOSITIONS = {
  // Came back at the grade it sold at. Its own listing goes live again,
  // unchanged. The commonest outcome by far.
  RELIST: {
    label: "Relist",
    relists: true,
    reprices: false,
    description: "Cosmetic grade unchanged. The unit's own listing goes back up at the same price.",
  },

  // Came back a grade lower. The same listing, re-graded and re-priced — the
  // difference is what the revised offer recovered from the customer.
  RELIST_REGRADED: {
    label: "Relist, re-graded",
    relists: true,
    reprices: true,
    description: "Cosmetic grade dropped. Re-graded, re-priced, and relisted.",
  },

  // Genuinely defective and bought in bulk on terms that allow a return.
  // Never available for a device bought from an individual — there is nobody
  // to send it back to.
  RETURN_TO_SUPPLIER: {
    label: "Back to supplier",
    relists: false,
    reprices: false,
    requiresBulkSource: true,
    description: "Defective and within supplier terms. Cost recovered up the chain.",
  },

  // Working, but not worth the effort of listing on its own.
  WHOLESALE: {
    label: "Wholesale",
    relists: false,
    reprices: false,
    description: "Working, batched for the wholesale channel.",
  },

  // Beyond economic repair. Written off with a reason, because a device that
  // vanishes without one is indistinguishable from a device that walked.
  SCRAP: {
    label: "Scrap",
    relists: false,
    reprices: false,
    description: "Beyond economic repair. Written off.",
  },
};

const DISPOSITION_TYPES = Object.keys(DISPOSITIONS);

const RELISTING_DISPOSITIONS = DISPOSITION_TYPES.filter((type) => DISPOSITIONS[type].relists);

// Writing a device off, or sending it up the chain, is a decision that needs a
// sentence behind it.
const REQUIRES_REASON = ["SCRAP", "RETURN_TO_SUPPLIER"];

// Where a unit came from. Only bulk stock can go back to a supplier; a device
// bought from a member of the public has nobody to return it to.
//
// UNKNOWN is the default and is deliberately permissive: the field is new, most
// of the catalogue has not been filled in, and hiding a legitimate route on
// every existing device would cost UpCell real recovery value. Only a source
// known to be an individual blocks it.
const ACQUISITION_SOURCES = ["BULK", "INDIVIDUAL", "UNKNOWN"];

const isDisposition = (type) =>
  Object.prototype.hasOwnProperty.call(DISPOSITIONS, type);

const relists = (type) => Boolean(DISPOSITIONS[type]?.relists);
const reprices = (type) => Boolean(DISPOSITIONS[type]?.reprices);

/**
 * Whether this route is available for a device from this source.
 *
 * Returns a sentence rather than a boolean when it is not, because the answer
 * a staff member needs is why, not no.
 */
function sourceAllows(type, acquisitionSource) {
  if (!DISPOSITIONS[type]?.requiresBulkSource) return { ok: true };

  if (acquisitionSource === "INDIVIDUAL") {
    return {
      ok: false,
      error: "This unit was bought from an individual, so there is no supplier to send it back to.",
    };
  }

  return { ok: true };
}

module.exports = {
  DISPOSITIONS,
  DISPOSITION_TYPES,
  RELISTING_DISPOSITIONS,
  REQUIRES_REASON,
  ACQUISITION_SOURCES,
  isDisposition,
  relists,
  reprices,
  sourceAllows,
};
