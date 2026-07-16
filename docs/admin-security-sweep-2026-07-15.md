# Admin dashboard hardening — audit log & permission sweep

Date: 2026-07-15

## Route-by-route auth audit

All routes under `Backend/src/routes/*.routes.js` were reviewed. Two gaps were found and fixed:

- `GET /order/:id` had no auth at all — anyone with the Mongo ID could read full customer PII (name, email, phone, address). Fixed with optional auth + PII field stripping for non-owners (see `Backend/src/controllers/order.controller.js` `getOrder`). Kept accessible without login because the guest checkout confirmation page (`Frontend/src/pages/ThankYou/ThankYou.jsx`) depends on it working without a session.
- `POST /this-month-sold-items` had no auth — anyone could overwrite the public "units sold" stat. Fixed with `verifyToken + requireAdmin` (`Backend/src/routes/monthlySell.routes.js`). Confirmed unused by the frontend, so no UI impact.

Every other admin-facing route (`product`, `catagory`/`shop-categories`, `trade-in`, `contact`, `newsletter`, `analytics`, `wholesale`, `email-config`, `notifications`) already used `verifyToken + requireAdmin` correctly. No further gaps found.

The legacy `Backend/controllers/` and `Backend/routes/` (root-level, pre-`src/` refactor) are not mounted in `Backend/src/app.js` and are dead code — out of scope for this sweep.

## Role model

Single `"admin"` role (via Clerk `publicMetadata.role`) is used everywhere. Given the size of the team and that every admin action is already gated the same way, a separate "staff" tier was not introduced — it would add complexity with no current use case. Revisit if/when the team needs to split full-admin vs limited-staff permissions.

## Audit log

New `AuditLog` model (`Backend/schema/auditLog.js`): `actorId`, `actorEmail`, `action`, `targetType`, `targetId`, `metadata`, `createdAt`/`updatedAt`.

Logged so far:
- `order.status_update` — written from `updateOrderStatus` (`Backend/src/controllers/order.controller.js`)
- `trade_in.status_update` — written from `updateTradeInStatus` (`Backend/src/controllers/tradeIn.controller.js`)

These are the two payment/status-adjacent admin actions called out in the original task list. Other admin writes (product/category/contact/newsletter edits) are not logged yet — add the same `AuditLog.create(...)` pattern to those controllers if broader coverage is wanted later.

Viewable at `GET /admin-audit-log` (admin-only, paginated) and in the dashboard under **Admin → Audit Log** (`Frontend/src/pages/Admin/AuditLog/AdminAuditLog.jsx`).

## Manual test checklist

- [ ] Change an order's status as admin → confirm a new entry appears in Admin → Audit Log with correct actor email, old/new status, and timestamp.
- [ ] Change a trade-in request's status as admin → same check.
- [ ] Hit `GET /order/:id` without logging in → confirm order loads (guest ThankYou flow) but response has no `name`/`email`/`phone`/`city`/`postal`/`street`/`country` fields.
- [ ] Hit `GET /order/:id` logged in as the order's own customer → confirm full order (including contact fields) is returned.
- [ ] Attempt `POST /this-month-sold-items` without an admin token → confirm 401/403.
