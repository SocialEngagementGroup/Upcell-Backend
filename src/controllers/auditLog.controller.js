const AuditLog = require("../models/auditLog.model");
const { getAdminListPagination, sendPaginatedResults } = require("../utils/pagination");

async function getAdminAuditLog(req, res, next) {
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    return sendPaginatedResults({
      res,
      model: AuditLog,
      query: {},
      sort: { createdAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getAdminAuditLog };
