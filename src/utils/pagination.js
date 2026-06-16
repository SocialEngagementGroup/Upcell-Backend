const ADMIN_LIST_DEFAULT_LIMIT = 10;
const ADMIN_LIST_MAX_LIMIT = 50;

function getAdminListPagination(req) {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, ADMIN_LIST_MAX_LIMIT)
    : ADMIN_LIST_DEFAULT_LIMIT;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function emptyPaginatedResponse({ res, page, limit }) {
  return res.status(200).json({
    items: [],
    pagination: {
      page,
      limit,
      totalItems: 0,
      totalPages: 1,
    },
  });
}

async function sendPaginatedResults({ res, model, query, sort, page, limit, skip }) {
  const [items, totalItems] = await Promise.all([
    model.find(query).sort(sort).skip(skip).limit(limit),
    model.countDocuments(query),
  ]);

  res.status(200).json({
    items,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    },
  });
}

module.exports = {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
};
