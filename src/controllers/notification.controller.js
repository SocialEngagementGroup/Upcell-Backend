const { Notification } = require("../models/notification.model");
const { getAdminListPagination, sendPaginatedResults } = require("../utils/pagination");

async function getAdminNotifications(req, res, next) {
  const { page, limit, skip } = getAdminListPagination(req);
  const query = req.query.filter === "unread" ? { isRead: false } : {};

  try {
    return sendPaginatedResults({
      res,
      model: Notification,
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

async function getUnreadNotificationCount(req, res, next) {
  try {
    const count = await Notification.countDocuments({ isRead: false });
    res.status(200).json({ count });
  } catch (error) {
    next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const updated = await Notification.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
}

module.exports = { getAdminNotifications, getUnreadNotificationCount, markNotificationRead };
