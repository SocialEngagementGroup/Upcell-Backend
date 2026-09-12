# Grading a device — bench sheet

**Print this and keep it at the bench.** One page. Everything on it comes from
`src/constants/grading.js` and `src/constants/inspectionChecklist.js`; if the
code changes, this sheet is wrong and needs regenerating.

Applies to a **returned** device and a **traded-in** one. Two checks differ —
marked below.

---

## The ten checks

Answer every one. The admin form will not submit an incomplete sheet.

| # | Check | Answer | Notes |
|---|---|---|---|
| 1 | **IMEI / serial matches the order** | Pass / Fail | **Critical.** On a return, compare against what the order says was sold. On a **trade-in there is nothing to compare against** — write the number down, that *is* the record |
| 2 | **Activation Lock / Find My iPhone is off** | Pass / Fail | **Critical.** A fail parks the device, it does not reject it — see below |
| 3 | **Powers on and boots** | Pass / Fail | |
| 4 | **Screen and touch respond** | Pass / Fail | Test all four corners and the centre |
| 5 | **Battery health %** | A number, 0–100 | Settings → Battery → Battery Health. **Never a deduction** |
| 6 | **Cosmetic grade** | Excellent / Good / Fair / Fail | Your judgement. See the scale below |
| 7 | **Liquid damage indicator clear** | Pass / Fail | A fail is a reject |
| 8 | **Still matches the grade it sold at** | Pass / Fail | **Returns only.** Skipped on a trade-in — UpCell never sold it, so there is no grade to match |
| 9 | **Unlocked and carrier-free** | Pass / Fail | A confirmation, not an assessment — UpCell only sells unlocked devices |
| 10 | **Reported fault reproduced** | Pass / Fail / N/A | Only when the customer claimed one. **N/A** for a change of mind |

---

## The grade is the lower of two things

The device takes the **worse** of its cosmetic grade and its battery band.

A phone at 91% battery with visible scratches is **Fair**, not Excellent. The
better number does not rescue the worse one, because a customer opening the box
sees the scratches.

### Battery bands

| Battery health | Band |
|---|---|
| 90% and above | Excellent |
| 85–89% | Good |
| 80–84% | Fair |
| **Below 80%** | **Not sellable at any grade** |

Boundaries are inclusive at the bottom: **90 is Excellent, 89 is Good, 85 is
Good, 84 is Fair, 80 is Fair, 79 is below grade.** Those exact numbers are what
you are looking at on a screen, so they are worth being precise about.

### Cosmetic grades

| Grade | What it means |
|---|---|
| **Excellent** | Looks unused. No marks you would notice holding it at arm's length |
| **Good** | Light marks visible close up. Nothing on the screen |
| **Fair** | Obvious scuffs, or marks on the screen that do not affect use |
| **Fail** | Cracked, bent, or damaged enough that it cannot be sold |

Worst to best: **Fail → Fair → Good → Excellent.**

---

## Below 80% battery is not a fail

A device below 80% still **works** and is still **in the building.** It is not
damaged and it is not the customer's fault.

Mark it `NEEDS_BATTERY`. It stays off the shop until the battery is replaced,
and then it is graded again.

**A battery drop is never damage.** Battery health falls during normal use —
that is what batteries do. A device sold at 90% that comes back at 81% has not
been mistreated, and re-grading or deducting for it would charge a customer for
physics. Record the number, because the next buyer needs it. Never take money
off for it.

---

## Activation Lock parks the device

If Activation Lock is still on, **stop.** Do not reject it and do not send it
back.

Mark the check failed. The system moves the request to **Blocked** and emails
the customer, and the clock stops while UpCell waits on them. Most people clear
it in two minutes once they know.

Rejecting a locked device costs UpCell the postage both ways and starts an
argument about a problem the customer could have solved. It is the whole reason
that state exists.

---

## Five photos, every time

The form will not submit without them:

1. **Front of the device**
2. **Back of the device**
3. **Screen, powered on**
4. **IMEI or settings screen**
5. **Any damage found**

These five answer the arguments that actually happen: what condition it arrived
in, that it was the right device, and that it powered on when UpCell said it
did.

Photos are deleted after **90 days** — except on a return that was rejected,
reduced, or is marked disputed, where they are kept indefinitely. Those are the
ones that turn into an argument later.

---

## What happens after you submit

The system **suggests** an outcome. It does not decide one — a checklist cannot
see a device and you can.

| What failed | Suggested |
|---|---|
| Activation Lock | **Blocked.** Waiting on the customer |
| IMEI does not match | **Reject.** This is not the device that was sold |
| Liquid damage | **Reject** |
| Worse than described | **Revised offer.** Less than the full amount, with reasons |
| Nothing | **Approve.** Full amount |

### If you are making a revised offer

Every deduction needs two things or the system will refuse it:

- **The check it failed on.** Pointing at a check that passed is worse than
  pointing at none — it looks evidenced when it is not.
- **The photo that shows it.** A customer told their offer dropped $90 for a
  scratch can ask to see the scratch.

And a reason in words the customer can read. A number with no explanation is
what gets disputed, and what UpCell then cannot defend.

---

## Quick answers

**The customer said Excellent and it is Fair.** Grade it Fair and make a
revised offer. Do not reject it — it is still worth something.

**Battery is 78%.** Not a fail. `NEEDS_BATTERY`, off the shop, grade it again
after the replacement.

**No IMEI on the order to compare against.** Common — most of the older
catalogue has none. Pass the check and write the number down. "We could not
check" is not the same as "we checked and it was right", and the record now says
which.

**Screen has a hairline crack the customer did not mention.** Cosmetic Fair or
Fail depending on severity, photo it, revised offer.

**Two devices, one box.** Two requests, two sheets. Do not combine them.

**It arrived with no label anybody can read.** Look it up by IMEI at the
receiving desk. Do not open a new request — that loses the quote the customer
was given, and they find out when they are paid the wrong amount.
