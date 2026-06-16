function errorHandler(err, req, res, next) {
  console.error("Global Error Handler:", err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Internal Server Error",
    details: err.details || null,
  });
}

module.exports = { errorHandler };
