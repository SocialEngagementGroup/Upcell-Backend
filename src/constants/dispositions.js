// Where a returned device goes once UpCell has decided to accept it.
//
// This is the answer to "what happens to the phone now". Without it an accepted
// return ends at the refund and the device becomes something on a shelf that
// nobody is responsible for — which is why a return cannot close until one of
// these has been chosen.
//
// UpCell sells certified new devices and the refurbished tier is being removed,
// so a returned device cannot simply go back on the site at its old listing.
// Four of the five routes are settled; OPEN_BOX is not, and its working default
// is wholesale.

const DISPOSITIONS = {
  // Seal never broken, so it is still legitimately a new device. The only one
  // that goes back on sale automatically.
  RESTOCK_NEW: {
    label: "Back to new stock",
    restocks: true,
    description: "Factory seal intact. Returns to sellable stock at full price.",
  },

  // Opened, working, unmarked. Fits none of the other four: not sealed, not
  // defective, not old. Likely the commonest outcome of a change-of-mind
  // return, which is why leaving it without a destination was not an option.
  //
  // Recorded distinctly even though it is handled as wholesale today. When
  // UpCell decides — wholesale, or back to the supplier if the agreement
  // permits unsealed stock — that is a change to what this routes to, not a
  // rebuild. See D-1 in the returns plan.
  OPEN_BOX: {
    label: "Open box",
    restocks: false,
    description: "Opened but in working order. Handled as wholesale pending a decision.",
  },

  // Genuinely defective and inside supplier or Apple warranty terms. Recovers
  // cost rather than UpCell eating it, where the agreement allows.
  RETURN_TO_SUPPLIER: {
    label: "Back to supplier",
    restocks: false,
    description: "Defective and within supplier terms. Cost recovered up the chain.",
  },

  // Working but not worth listing on its own — older model, minor marks, or
  // simply volume.
  WHOLESALE: {
    label: "Wholesale",
    restocks: false,
    description: "Working, batched for the wholesale channel.",
  },

  // Beyond economic repair. Written off with a reason, because a device that
  // vanishes without one is indistinguishable from a device that walked.
  SCRAP: {
    label: "Scrap",
    restocks: false,
    description: "Beyond economic repair. Written off.",
  },
};

const DISPOSITION_TYPES = Object.keys(DISPOSITIONS);

// Only one route puts a device back on sale. Everything else creates a record
// for a person to act on, which is deliberate: automatically listing an opened
// device as new is the mistake this whole model exists to prevent.
const RESTOCKING_DISPOSITIONS = DISPOSITION_TYPES.filter((type) => DISPOSITIONS[type].restocks);

// Writing a device off is a decision that needs a sentence behind it.
const REQUIRES_REASON = ["SCRAP", "RETURN_TO_SUPPLIER"];

const isDisposition = (type) =>
  Object.prototype.hasOwnProperty.call(DISPOSITIONS, type);

const restocks = (type) => Boolean(DISPOSITIONS[type]?.restocks);

module.exports = {
  DISPOSITIONS,
  DISPOSITION_TYPES,
  RESTOCKING_DISPOSITIONS,
  REQUIRES_REASON,
  isDisposition,
  restocks,
};
