const validateRequest = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (error) {
    const issues = error?.issues || error?.errors;
    if (issues) {
      return res.status(400).json({
        error: "Validation failed",
        message: issues[0]?.message || "One or more fields are invalid.",
        details: issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        })),
      });
    }
    next(error);
  }
};

module.exports = { validateRequest };
