# Migration log

Which script ran, against which database, on what date.

**This file exists because nothing recorded it before.** Every migration was run
against development and none against production, and nobody noticed until the
two were compared field by field on 18 September 2026 — seven fields present on
all 956 development products and on none of the 954 in production. That is not
a mistake anybody made twice; it is a mistake nobody could see.

## The rule

**Add a row the moment a script finishes with `--write`.** Not at the end of the
day, not in the pull request. A row that is not written while the terminal is
still open is a row that does not get written.

Every script prints its target database and whether it is writing, before it
connects (`scripts/lib/announce-db.js`). Copy what it printed. Do not copy what
you meant to run.

---

## Log

| Date | Script | Database | Effect |
|---|---|---|---|
| 2026-09-19 | `set-condition-premium.js --write` | `upcell_development` | 956 set to Premium. Originals already in `conditionLegacy` — Excellent 491, Mint 248, Good 215, New 2 |
| 2026-09-19 | `migrate-trade-in-status.js --write` | `upcell_development` | 1 trade-in, `New -> Quoted`, direct mapping |
| 2026-09-19 | `fix-legacy-gateway-rows.js --write` | **`upcell_production`** | 6 orders repaired (Stripe/Paypal -> Card, original in `legacyPaidWith`); 8 orphan logs deleted, exported to `backups/deleted-payment-logs-1789822732796.json` first |
| 2026-09-19 | `backfill-is-accessory.js --write` | **`upcell_production`** | 954 set to `isAccessory: false`. Production holds no accessory products at all |
| 2026-09-19 | `backfill-device-identity.js --write` | **`upcell_production`** | 954: `deviceType` (PHONE 318, TABLET 270, LAPTOP 366), `carrierStatus`, `refurbState` |
| 2026-09-19 | `migrate-trade-in-status.js --write` | **`upcell_production`** | 7 of 9 changed. **All direct mappings** — `New -> Quoted` x6, `Received -> DeviceReceived` x1. No ambiguous old `Quoted`, so no RevisedOffer deadline was invented |
| 2026-09-19 | `set-condition-premium.js --write` | **`upcell_production`** | 954 set to Premium. Originals kept: Excellent 480, Mint 254, Good 220 |
| 2026-09-19 | dev cleanup | `upcell_development` | 1 orphan order removed (exported first); `cosmeticGrade` unset on 956 |
| 2026-09-19 | `backfill-product-photos.js --report --write` | `upcell_development` | 247 products given a colour-matched photo. 71 left alone — no photo of that colour exists |
| 2026-09-19 | `backfill-product-photos.js --report --write` | **`upcell_production`** | 235 products given a colour-matched photo. Distinct photos 173 -> 180. Wrong-colour sharing 28 -> 2. CSV and undo file in `backups/` |
| 2026-09-19 | `clear-wrong-colour-photos.js --write` | `upcell_development` | 51 products cleared — their photo was the wrong colour |
| 2026-09-19 | `clear-wrong-colour-photos.js --write` | **`upcell_production`** | 51 products cleared: `hero-iphone15` across 19 (the homepage banner used as a product shot) and `ipad-air-m4` across 32. They now show the placeholder. Wrong-colour photos: 2 -> 0 |
| 2026-09-19 | `migrate-order-items.js --apply` | **`upcell_production`** | All 10 orders moved off the legacy `line_items` shape. 10 clean, 0 flagged. Fixed a live bug: the guest order page read `order.items` with no fallback, so every guest saw "What you bought" empty and a blank total |

---

## Production, verified after the 19 September run

```
refurbState      954/954      conditionLegacy  954/954
carrierStatus    954/954      slug             954/954
deviceType       954/954      condition        ["Premium"]
isAccessory      954/954      conditionLegacy  ["Excellent","Good","Mint"]

orders           10  {Card 6, Manual 4}   failing schema: 0
payment logs     11  legacy gateway: 0
trade-ins         9  {Quoted 6, DeviceReceived 1, Closed 1, Rejected 1}
dangling lines    0
```

Two fields are still 0 of 954 and are **meant to be**:

| Field | Why it stays empty |
|---|---|
| `cosmeticGrade` | The Premium decision. `set-condition-premium.js` replaced the migration that would have written it |
| `imageIsGeneric` | Written only by the bulk importer, to mark a stand-in photo. Nothing in production was bulk-imported |

`imei` and `serialNumber` are also 0 of 954. No script can fill them.

### Photos, after the backfill

```
products                954
distinct model + colour 269      <- one photo each would be the ceiling
distinct photos         180      (was 173)
shared, same colour      50      correct: same chassis, same colour
shared, WRONG colour      2      affecting 51 products
```

The two remaining are `hero-iphone15` across 6 combos and `ipad-air-m4` across
10. Both persist because **the photos do not exist** — 22 model+colour
combinations UpCell sells have never been photographed. `backfill-product-photos.js`
prints that list on every run; the largest gap is **Starlight**, sold on eight
different models with no photo of any of them.

`hero-iphone15` is the homepage marketing banner being used as a product shot.
Nothing can fix that except a real photograph.

---

## Do not run

| Script | Why |
|---|---|
| `migrate-condition-to-grade.js` | Maps the catalogue onto the returns scale so a customer can be shown one of three grades. That is the opposite of the Premium decision of 19 September 2026. `set-condition-premium.js` replaces it. The two are alternatives, not steps |
| `update-product-images-from-manifest.js` | Deleted 19 Sep. Wrote `image`, not `imagePublicId`, and its matcher predated three fixes. `backfill-product-photos.js` replaces it |
| `rebuild-frontend-manifest.js` | Deleted 19 Sep. It rewrote `Frontend/src/data/productImageManifest.js`, which no longer exists — the manifest moved to `scripts/data/` as migration input |
| `mark-generic-images.js` | Deleted 19 Sep. It wrote `imageIsGeneric`, which no code reads any more |
| `backfill-product-photos.js --allow-colour-fallback` | The flag exists and should stay off. It lets the matcher assign a photo of the wrong colour when the right one does not exist — an iPhone 16e in Ultramarine was offered 16_E_Black.png. A customer seeing the wrong colour believes it is what they ordered |

---

## Known, and not fixable by a script

| Thing | Detail |
|---|---|
| `backfill-image-public-ids.js` on development | 942 of 956 carry an `imagePublicId`. The remaining 14 come back **unresolved** — the script cannot find a Cloudinary id for them, so re-running does nothing. Production is complete at 954 of 954, so this is development-only |
| IMEI and serial numbers | 954 of 954 production devices have neither. No script can invent them; somebody has to walk the shelves |
