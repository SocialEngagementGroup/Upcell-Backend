const { isValidObjectId } = require("../utils/objectId");

// Rejects a malformed :id before it ever reaches a controller's findById.
// Without this, a bad id throws a Mongoose CastError, which the global error
// handler cannot tell apart from a real fault and answers with a 500 — the
// same class of problem getOrder (order.controller.js) already guards
// against by hand, applied here to every other findById-by-url-param route.
const validateObjectIdParam = (paramName = "id") => (req, res, next) => {
  if (!isValidObjectId(req.params[paramName])) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
};

module.exports = { validateObjectIdParam };
