# What UpCell keeps, for how long, and what happens when somebody asks to be deleted

**Written 11 September 2026.** Describes what the code does today, not what a
policy says it should. Where the two differ, this file is the accurate one.

**For Ashraf to hand to counsel.** Nothing here is legal advice, and the
Privacy Policy has deliberately not been edited to match it — a lawyer should
decide what the public text says.

---

## What is stored

| Data | Where | Why it exists |
|---|---|---|
| Name, email, phone, shipping address | `orders` | Delivering the order, and answering a chargeback |
| Card brand and last four digits | `orders` | So a customer can tell which card paid |
| Gateway transaction ids, AVS and CVN results, authorised amount | `orders` | Reconciling against the bank; defending a disputed charge |
| A **hashed** checkout IP and the browser's user agent | `orders` | Chargeback evidence. The raw IP is never stored — see below |
| IMEI and serial of each device sold | `orders.items` | Tying a physical device to the sale, a return, and a warranty claim |
| Name, email, phone, device details | `tradeinrequests` | Quoting, collecting and paying for a traded-in device |
| Email, inspection photos, an append-only timeline | `refundrequests` | Evidence in a return dispute |
| Name, email, message | `contactsubmissions` | Answering the message |
| Email | `newslettersubscribers` | Sending the newsletter |
| Staff actions with actor, target and timestamp | `auditlogs` | Who did what. Append-only by design |
| Anonymous page and form events | `analytics_events` | Product analytics |

Passwords are not stored at all. Authentication is Clerk's, and UpCell holds
no credential of any kind.

Full payment card numbers are never stored, never logged, and never reach
UpCell's servers — the bank's hosted page collects them directly.

---

## How long

| Data | Retained | Deleted by |
|---|---|---|
| `analytics_events` | **90 days** | A MongoDB TTL index. Automatic, nothing to run |
| Return inspection photos | **90 days** from upload | `purgeInspectionPhotos`, daily. Held indefinitely while a return is rejected, reduced, under a revised offer, or flagged disputed — those are the ones that turn into an argument later |
| A guest's order link | **90 days** | The token expires; the order stays |
| A revised-offer link | Until the offer is answered | Rotated when a new offer is made |
| Orders, trade-ins, returns | **Indefinitely**, anonymised on request | See below |
| Audit log | **Indefinitely** | Append-only. Never edited, never deleted |

**There is no automatic deletion of order history.** That is a deliberate gap
and counsel should decide the period: tax records in Ohio are commonly kept
seven years, and a 12-month warranty claim needs the order behind it.

---

## What happens on `DELETE /account/me`

Anonymisation, not deletion, for anything financial. The request cannot be
undone.

**Anonymised — the record survives, the person does not**

- `orders` — name becomes "Deleted account", the address and phone are
  removed, the email becomes `deleted-<hash>@deleted.invalid`, and the Clerk
  id is cleared. Amounts, dates, devices, IMEIs and the refund record stay
  exactly as they were.
- `tradeinrequests` — the same treatment.
- `refundrequests` — the email is replaced and the access token removed. The
  inspection, the photos and the timeline stay, because they are the evidence
  in a dispute that may outlive the account.

**Deleted outright**

- `contactsubmissions` and `newslettersubscribers`. Neither has a financial
  or evidential claim on it.
- The guest order token, the return access token, the hashed checkout IP and
  the user agent. A link in an old receipt must not still open an order
  belonging to somebody who asked to be forgotten.
- The Clerk user, last of all. If that call fails the data is already gone and
  only the login remains, which is the half a person can clear by hand.

**The pseudonym.** Every anonymised row for one person gets the same
`deleted-<12 hex>` stand-in, so two orders from the same deleted customer
still group together in a report without naming anybody. It is a salted
SHA-256 of the address, truncated. The original cannot be recovered from it,
and that is the requirement rather than a limitation.

**Why the IP is hashed and salted.** The question a chargeback asks is whether
two orders came from the same place, and a digest answers that. The raw value
would only add the ability to tell where a customer lives. It is salted
because four billion IPv4 addresses is a dictionary anyone can exhaust in
minutes — unlike a 256-bit token, an unsalted IP hash is reversible in
practice.

---

## Open questions for counsel

1. **How long should order history be kept** before anonymising it
   automatically? Nothing expires today.
2. **Is anonymisation sufficient** where a customer asks for erasure, given
   the record retains amounts, dates and device identifiers?
3. **The audit log is append-only and names staff, not customers.** Confirm
   that is the right side of the line.
4. **Return photos are held indefinitely while a case is disputed.** There is
   no outer limit; should there be one?
5. **The Privacy Policy has not been updated** to match any of this. It should
   be read against this document before launch.
