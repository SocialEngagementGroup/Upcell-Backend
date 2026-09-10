// How a used device is graded, and what happens to that grade when one comes
// back.
//
// Two independent axes, and the device takes the lower of the two. A phone at
// 91% battery with visible scratches is Fair, not Excellent — the better number
// does not rescue the worse one, because a customer opening the box sees the
// scratches.
//
// The single most important rule in this file is that a battery drop is not
// damage. Battery health falls during normal use; that is what batteries do.
// A device sold at 90% that comes back at 81% has not been mistreated, and
// re-grading or deducting for it would charge a customer for physics. The
// inspection still records the number, because the next buyer needs it, but it
// can never move the grade or take money off.

const GRADES = {
  EXCELLENT: "EXCELLENT",
  GOOD: "GOOD",
  FAIR: "FAIR",
  FAIL: "FAIL",
};

// Worst first, so an index comparison answers "which is lower".
const GRADE_ORDER = [GRADES.FAIL, GRADES.FAIR, GRADES.GOOD, GRADES.EXCELLENT];

// A battery below 80% is not sellable at any grade. Distinct from FAIL, which
// means the device itself is broken — this one still works, it just cannot be
// listed until the battery is replaced.
const BELOW_GRADE = "BELOW_GRADE";

const BATTERY_BANDS = [
  { min: 90, grade: GRADES.EXCELLENT },
  { min: 85, grade: GRADES.GOOD },
  { min: 80, grade: GRADES.FAIR },
];

/**
 * The grade a battery percentage earns on its own.
 *
 * Boundaries are inclusive at the bottom: 90 is Excellent, 89 is Good, 85 is
 * Good, 84 is Fair, 80 is Fair, 79 is below grade. Those exact numbers are the
 * ones staff will be looking at on a screen, so they are worth being precise
 * about rather than approximately right.
 */
function batteryBand(percentage) {
  // null and "" both become 0 through Number(), which would read as a dead
  // battery and fail the device. A missing reading is not a bad reading.
  if (percentage === null || percentage === undefined || percentage === "") return null;

  const value = Number(percentage);
  if (!Number.isFinite(value)) return null;

  const band = BATTERY_BANDS.find((entry) => value >= entry.min);
  return band ? band.grade : BELOW_GRADE;
}

const isGrade = (grade) => GRADE_ORDER.includes(grade);

/** Which of two grades is worse. */
function lowerGrade(left, right) {
  if (!isGrade(left)) return isGrade(right) ? right : null;
  if (!isGrade(right)) return left;
  return GRADE_ORDER.indexOf(left) < GRADE_ORDER.indexOf(right) ? left : right;
}

/**
 * The grade the device actually gets.
 *
 * The lower of the two axes, and FAIL on either wins outright — a cracked
 * screen is a cracked screen whatever the battery says. A battery below 80%
 * also produces FAIL here, because the device is not listable until it is
 * replaced, but the reason is recorded separately so nobody reads it as
 * physical damage.
 */
function finalGrade({ batteryHealth, cosmeticGrade }) {
  const battery = batteryBand(batteryHealth);

  if (cosmeticGrade === GRADES.FAIL) return GRADES.FAIL;
  if (battery === BELOW_GRADE) return GRADES.FAIL;

  // No battery reading: the cosmetic grade stands alone rather than the device
  // being failed for a missing number.
  if (!battery) return isGrade(cosmeticGrade) ? cosmeticGrade : null;
  if (!isGrade(cosmeticGrade)) return battery;

  return lowerGrade(battery, cosmeticGrade);
}

/**
 * What happens to a device that has come back.
 *
 * Compares only the cosmetic grade. That is the whole point: the battery is
 * excluded by policy, so a device whose battery fell nine points but which
 * looks exactly as it did goes straight back on its own listing at its own
 * price.
 *
 * @returns {{disposition, regraded, from, to, reason}}
 */
function regradeOnReturn({ gradeAtSale, cosmeticGrade }) {
  // Nothing to compare against — an older listing with no recorded grade.
  // Relisting at the grade found is the honest answer, and it is flagged so a
  // person can look.
  if (!isGrade(gradeAtSale)) {
    return {
      disposition: "RELIST",
      regraded: false,
      from: gradeAtSale || null,
      to: cosmeticGrade,
      reason: "No grade was recorded when this sold, so it relists at the grade found.",
    };
  }

  if (cosmeticGrade === GRADES.FAIL) {
    return {
      disposition: "SCRAP",
      regraded: true,
      from: gradeAtSale,
      to: GRADES.FAIL,
      reason: "Cracked, liquid damaged, or structurally damaged.",
    };
  }

  const worse = lowerGrade(gradeAtSale, cosmeticGrade) === cosmeticGrade
    && cosmeticGrade !== gradeAtSale;

  if (worse) {
    return {
      disposition: "RELIST_REGRADED",
      regraded: true,
      from: gradeAtSale,
      to: cosmeticGrade,
      reason: `Came back ${cosmeticGrade} against ${gradeAtSale} at sale.`,
    };
  }

  // Same grade, or better than it sold at. Better does not get re-graded up:
  // the listing said what it said, and the customer paid that price.
  return {
    disposition: "RELIST",
    regraded: false,
    from: gradeAtSale,
    to: gradeAtSale,
    reason: "Cosmetic condition is unchanged.",
  };
}

/**
 * Whether a proposed deduction is allowed to exist.
 *
 * Battery decline is refused outright rather than merely not suggested. The
 * difference matters: staff can type any amount they like into a deduction, and
 * "the battery is down to 82%" is a reason someone would write in good faith.
 */
function isDeductibleFinding({ findingKey, reason }) {
  const text = `${findingKey || ""} ${reason || ""}`.toLowerCase();

  if (/batter/.test(text)) {
    return {
      ok: false,
      error:
        "Battery decline is normal wear and cannot be deducted for. Record the reading on the inspection instead.",
    };
  }

  return { ok: true };
}

module.exports = {
  GRADES,
  GRADE_ORDER,
  BELOW_GRADE,
  BATTERY_BANDS,
  batteryBand,
  lowerGrade,
  finalGrade,
  regradeOnReturn,
  isDeductibleFinding,
  isGrade,
};
