# scripts/

Every script here connects to whatever `MONGODB_URL` points at. Check which
database it printed before you answer a prompt — the development database is
the one the live site writes to, so "development" is a misleading name.

Anything that writes defaults to a dry run. `--write` (or `--apply`, or
`--yes` — the script says which) is what makes it real.

## Why these still exist

**None of these migrations has been run against production.** The production
database has not been populated yet. Every "already applied" note below means
applied to `upcell_development` only, and the same script has to run again at
launch. That is the reason to keep them rather than trust git history: at
launch you want a file you can run, not a commit you have to resurrect.

## Run when you need them

| Script | What it does |
|---|---|
| `reconcile.js` | `npm run reconcile`. Finds payments the host slept through. Exits non-zero on anything critical, so it can run from a cron |
| `clear-test-data.js` | `npm run clear-test-data`. Resets the development database. Writes a full dump to `Backend/backups/` first, even on a dry run |
| `seed-accessories.js` | `npm run seed-accessories`. Puts the accessory catalogue back |
| `sync-catalog-dev-to-prod.js` | Copies catalogue presentation fields from development to production. **For launch** |
| `migrate-images-to-cloudinary.js` | Bulk-uploads local images and writes `cloudinary-manifest.json` |
| `rebuild-frontend-manifest.js` | Rewrites `Frontend/src/data/productImageManifest.js` from that manifest. Run it whenever product photos change — 510 of 956 products get their picture from that file |
| `repair-order-product-links.js` | Reconnects order lines pointing at a product that no longer exists. The cause is fixed, but a deleted product still orphans its orders |
| `migrate-order-items.js` | Chunk 6 of the order model migration. Idempotent. **Has to run against production** |

## Read-only audits

Safe to run any time; they change nothing.

| Script | Question it answers |
|---|---|
| `audit-iphone-catalog.js` | Does each iPhone family have the variants it should? |
| `audit-product-categories.js` | Is every parent attached to a real shop category? |
| `audit-variant-categories.js` | Does any variant disagree with its parent's category? |

## Applied to development, still needed for production

Each is idempotent and dry-runs by default. Run them in this order against a
fresh database.

| Script | Applied | What it writes |
|---|---|---|
| `backfill-slugs.js` | 2026-09-09 | The slug every product URL is built from |
| `backfill-is-accessory.js` | 2026-09-09 | `isAccessory: false` on products that predate the field |
| `backfill-image-public-ids.js` | 2026-08-17 | A Cloudinary `publicId` beside every image reference |
| `mark-generic-images.js` | 2026-09-09 | `imageIsGeneric` — which photos are stand-ins rather than that exact unit |
| `migrate-condition-to-grade.js` | 2026-09-10 | Moves the catalogue onto the returns grading scale. 956 products, none unmapped |
| `update-parent-descriptions.js` | 2026-08-17 | Family descriptions from `parent-descriptions.json` |
| `update-product-images-from-manifest.js` | 2026-08-17 | Product photos from the Cloudinary manifest |
| `fix-product-categories.js` | 2026-08-17 | Reattaches products to the right shop category |
| `cleanup-obsolete-apple-models.js` | 2026-08-17 | Removes Apple models UpCell does not sell |
| `fix-shop-category-images.js` | 2026-09-10 | Repoints category images at Cloudinary. The old ones were local paths that 404 |

## Finished

| Script | Why it is kept |
|---|---|
| `clear-pre-v3-returns.js` | Removed the 7 returns written before the v3 rewrite. Production has no returns yet, so this will not be needed there — kept as the record of what was deleted and why |
| `migrate-mongo-data.js` | Copies one database to another via `OLD_MONGODB_URL` / `NEW_MONGODB_URL`. Generic enough to want again |

## Data files

| File | Read by |
|---|---|
| `cloudinary-manifest.json` | `backfill-image-public-ids.js`, `rebuild-frontend-manifest.js` |
| `parent-descriptions.json` | `update-parent-descriptions.js` |
| `removed-*.json` | Nothing. Safety copies written by a script before it deletes. Gitignored. Delete once you are happy |
