// Escapes regex metacharacters so user input can be safely interpolated into
// a `new RegExp()` call (e.g. a $regex Mongo filter) without the string being
// interpreted as a pattern — prevents both accidental matches and
// ReDoS-crafted input from reaching RegExp construction.
const escapeRegex = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { escapeRegex };
