// Rounds a dollar amount to the nearest cent. Multiplying a device price by a
// quantity, or summing several already-rounded figures, can drift by a
// fraction of a cent in IEEE-754 floating point (e.g. 99.99 * 3 stored as
// 299.96999999999997) — this is the one place that gets snapped back before
// the value is stored or compared. Never store an unrounded float for money.
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

module.exports = { round2 };
