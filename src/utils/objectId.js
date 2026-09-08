// Mongo ObjectId as it appears in a URL — exactly 24 hex characters. Checking
// the shape before querying keeps a malformed id (a stale link, a crawler, a
// probe) a plain 404 instead of a CastError, which the global handler has no
// way to tell apart from a real fault and answers with a 500 — paging the
// admin over a bot poking /product/abc.
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const isValidObjectId = (value) => OBJECT_ID_PATTERN.test(value || "");

module.exports = { OBJECT_ID_PATTERN, isValidObjectId };
