const AnalyticsEvent = require("../models/analyticsEvent.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");

async function createAnalyticsEvent(req, res, next) {
  try {
    const event = await AnalyticsEvent.create(req.body);
    res.status(201).json({ _id: event._id });
  } catch (error) {
    next(error);
  }
}

async function getAdminAnalyticsSummary(req, res, next) {
  const rawDays = Number.parseInt(req.query.days, 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 30;
  const since = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
  const timeQuery = { createdAt: { $gte: since } };

  try {
    const [
      successfulSubmits,
      failedSubmits,
      formDropoffs,
      adminApiErrors,
      topFailedForms,
      topDropoffForms,
      recentEvents,
    ] = await Promise.all([
      AnalyticsEvent.countDocuments({ ...timeQuery, category: "form_submit", status: "success" }),
      AnalyticsEvent.countDocuments({ ...timeQuery, category: "form_submit", status: "failed" }),
      AnalyticsEvent.countDocuments({ ...timeQuery, category: "form_dropoff" }),
      AnalyticsEvent.countDocuments({ ...timeQuery, category: "admin_api_error" }),
      AnalyticsEvent.aggregate([
        { $match: { ...timeQuery, category: "form_submit", status: "failed" } },
        { $group: { _id: "$formName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { ...timeQuery, category: "form_dropoff" } },
        { $group: { _id: "$formName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      AnalyticsEvent.find(timeQuery).sort({ createdAt: -1 }).limit(8),
    ]);

    res.status(200).json({
      windowDays: days,
      cards: {
        successfulSubmits,
        failedSubmits,
        formDropoffs,
        adminApiErrors,
      },
      topFailedForms,
      topDropoffForms,
      recentEvents,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminAnalyticsEvents(req, res, next) {
  const { page, limit, skip } = getAdminListPagination(req);
  const { category, status, formName } = req.query;
  const query = {};

  if (category && category !== "all") query.category = category;
  if (status && status !== "all") query.status = status;
  if (formName) query.formName = formName;

  try {
    return sendPaginatedResults({
      res,
      model: AnalyticsEvent,
      query,
      sort: { createdAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createAnalyticsEvent,
  getAdminAnalyticsSummary,
  getAdminAnalyticsEvents,
};
