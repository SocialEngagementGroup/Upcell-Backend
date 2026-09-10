// What kind of thing a catalogue row is, and what identifies one of them.
//
// Every unit is its own record, so the identity on that record is the only
// thing tying a physical device to the order that sold it, the return that
// brought it back, and the trade-in it arrived on. Without it a dispute months
// later is one person's word against another's.

const DEVICE_TYPES = ["PHONE", "TABLET", "LAPTOP", "ACCESSORY"];

// What each kind is identified by.
//
// A phone shows an IMEI; a tablet or a laptop shows a serial. Demanding both
// would make the check something staff work around, which is worse than
// demanding the one the device actually displays.
const IDENTIFIER_FOR = {
  PHONE: "imei",
  TABLET: "serialNumber",
  LAPTOP: "serialNumber",
  // A case is not a device. It has no identity to record and never will.
  ACCESSORY: null,
};

const CARRIER_STATUSES = ["UNLOCKED", "ATT", "VERIZON", "TMOBILE", "OTHER"];

// Whether a unit can be sold as it stands.
//
// Separate from outOfStock, which says whether it is on the shelf. A device can
// be in the building and still not sellable — a battery below 80% works, but
// UpCell does not list it until the battery is replaced.
const REFURB_STATES = ["SELLABLE", "NEEDS_BATTERY", "NEEDS_REPAIR"];

/**
 * The device type a category name implies.
 *
 * Read from categoryName because that is what the catalogue has. Every one of
 * the ten real categories maps cleanly; anything unrecognised returns null
 * rather than a guess, so the backfill reports it instead of quietly filing a
 * Mac as a phone.
 */
function deviceTypeFromCategory(categoryName, { isAccessory } = {}) {
  if (isAccessory) return "ACCESSORY";

  const name = String(categoryName || "").toLowerCase();
  if (!name) return null;

  if (name.includes("iphone")) return "PHONE";
  if (name.includes("ipad")) return "TABLET";
  if (name.includes("macbook") || name.includes("mac")) return "LAPTOP";

  return null;
}

/**
 * Whether this unit carries the identity its type needs.
 *
 * @returns {{ok: true} | {ok: false, error, missing}}
 */
function hasIdentity(product) {
  const deviceType = product?.deviceType
    || deviceTypeFromCategory(product?.categoryName, { isAccessory: product?.isAccessory });

  const field = IDENTIFIER_FOR[deviceType];

  // An accessory, or a type nobody has classified yet. Neither is a device
  // whose identity can be demanded.
  if (!field) return { ok: true };

  const value = String(product?.[field] || "").trim();
  if (value) return { ok: true };

  return {
    ok: false,
    missing: field,
    error: field === "imei"
      ? "This phone has no IMEI recorded."
      : "This device has no serial number recorded.",
  };
}

/**
 * Whether identity is being enforced yet.
 *
 * Off by default, and that is the whole reason the flag exists. 956 catalogue
 * rows predate these fields, and turning enforcement on before somebody has
 * physically walked the shelf with a scanner would refuse checkout for most of
 * the shop. X9 in PIPELINE.md is the audit; this flag is what it unlocks.
 *
 * Read per call rather than at import, so a deploy that sets it takes effect
 * without the module having been reloaded in the right order.
 */
const identityRequired = () => process.env.IDENTITY_REQUIRED === "true";

module.exports = {
  DEVICE_TYPES,
  CARRIER_STATUSES,
  REFURB_STATES,
  IDENTIFIER_FOR,
  deviceTypeFromCategory,
  hasIdentity,
  identityRequired,
};
