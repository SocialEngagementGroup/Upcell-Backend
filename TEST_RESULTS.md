# UpCell backend — test report

**Regenerated 12 September 2026** from `npx jest --coverage` at HEAD on
`dev-sunit`. Replaces a report dated 23 July 2026 that described 5 suites, 184
tests, and mocked Stripe — none of which is still true.

---

## Result

**63 suites, 1,633 tests, all passing.** Time: about 25 seconds with coverage,
6 without.

No database, no network, no mail server. Every service takes its dependencies
as arguments so it can be tested without them — if a suite starts wanting a
connection, something has been wired wrong.

```bash
npm test
```

Check the exit code rather than reading the output:

```bash
npx jest >/dev/null 2>&1; echo "exit: $?"
```

A piped command returns the exit code of the **last** command in the pipe, so
`npx jest | tail -4 && git commit` will commit over a red suite, because `tail`
always succeeds. That has happened here.

---

## Coverage

| Area | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| **All files** | **81.3%** | **70.8%** | **72.5%** | **82.4%** |
| `src/` (entry) | 97.3% | 87.5% | 83.3% | 97.1% |
| `src/config` | 100% | 100% | 100% | 100% |
| `src/constants` | 97.8% | 91.1% | 94.4% | 100% |
| `src/services` | 93.3% | 80.8% | 88.6% | 93.8% |
| `src/models` | 99.3% | 100% | 0% | 99.3% |
| `src/middleware` | 89.9% | 84.5% | 82.6% | 91.2% |
| `src/utils` | 81.3% | 72.2% | 73.2% | 84.8% |
| `src/schemas` | 81.7% | 37.5% | 51.9% | 81.8% |
| `src/controllers` | 71.2% | 63.4% | 59.0% | 73.2% |

### How to read those numbers

**The shape matters more than the total.** `services/` is where every rule that
decides money lives, and it is at 93%. `controllers/` is at 71% and that is the
right way round: a controller mostly reads a request, calls a service and
answers, and the parts of it that are not covered are error branches rather than
decisions.

**`models/` shows 0% function coverage and that is meaningless.** The
"functions" in a Mongoose schema are validators and virtuals that the driver
calls, not code any test invokes directly.

**`schemas/` at 37% branch coverage is the honest gap.** Zod branches are one
per field per failure mode, and only the ones that have gone wrong in practice
are tested. That is a deliberate choice rather than an oversight — but it is
also how `revisedOfferSchema` silently stripped `photoIds` for weeks, which
broke every revised refund offer. There is now a regression test for that one.

---

## What is well covered

Everything that decides money or condition, because those are the failures that
are expensive and quiet:

| Area | Suites |
|---|---|
| Refunds and eligibility | `refund`, `refundEligibility`, `returnWindow`, `warranty` |
| Grading and inspection | `grading`, `returnInspection`, `returnDisposition`, `revisedOffer` |
| Returns workflow | `returnStatus`, `returnTimeline`, `returnAuthorisation`, `returnSla`, `returnJobs`, `returnShipping`, `returnSettlement`, `returnPhotos`, `returnRiskFlags`, `returnReporting`, `rma` |
| Trade-ins | `tradeInStatus`, `tradeInPricing`, `tradeInPriceBook`, `tradeInIntake`, `tradeInReporting`, `tradeIn.controller`, `payoutSafety` |
| Catalogue | `productImport`, `productImport.controller`, `product.controller`, `inventory`, `deviceIdentity`, `slug`, `modelIndexes` |
| Orders and money | `order.controller`, `order.model`, `orderItems`, `money`, `salesTax`, `checkout.controller`, `reconciliation` |
| Reviews | `review.controller`, `reviewPrompt` |
| Security and plumbing | `auth.middleware`, `cors`, `securityHeaders`, `scrubPayload`, `validateObjectId.middleware`, `request.schemas`, `error.middleware`, `disabledRoutes`, `pagination`, `health` |
| Accounts | `accountDeletion`, `guestCheckout` |

---

## What is not covered, and why

| Not covered | Why |
|---|---|
| **Routes as HTTP** | There is no supertest layer. Routes are checked by loading the router, which catches an undefined handler — a real bug that way, when `getCartProducts` was dropped and `POST /cart` would have 500'd on every cart page load. It does not catch a wrong middleware order |
| **Bank of America end to end** | The signing is tested; the round trip to the bank is not, and cannot be without a live merchant account. See HANDOVER.md |
| **Cloudinary** | The delete guard is tested against a fake. The API itself is not |
| **Email rendering** | `emailTemplates` is tested for content, not for how it looks in Outlook |
| **The frontend** | Separate suite: 44 Vitest tests and one Playwright smoke test |

---

## Tests are written to fail

Every rule in this codebase was verified by deliberately breaking the code and
confirming a test caught it. A test that passes whether or not the code works is
worse than no test, because it is trusted.

Two were caught that way and fixed: a `photoIds` assertion that could not fail,
and a `pageerror` listener in the smoke test attached after the navigation it
was meant to watch.

The comments in the test files say *why* each rule exists, not what the code
does. `tests/warranty.test.js` and `tests/payoutSafety.test.js` are the clearest
examples if you want the house style.

---

## Frontend

```bash
cd ../Frontend
npm test          # 44 Vitest tests
npm run build     # the real gate
npm run test:e2e  # Playwright, needs E2E_BASE_URL
```

`npm run build` is the gate rather than `npm test`: there are no component
tests, so a broken import is caught by Vite rather than Vitest.
