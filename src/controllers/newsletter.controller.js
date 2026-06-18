const NewsletterSubscriber = require("../models/newsletterSubscriber.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");

async function createNewsletterSubscriber(req, res, next) {
  try {
    const email = req.body.email.trim().toLowerCase();
    const source = req.body.source || "footer";

    const subscriber = await NewsletterSubscriber.findOneAndUpdate(
      { email },
      { email, source, status: "Active" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json(subscriber);
  } catch (error) {
    next(error);
  }
}

async function getAdminNewsletterSubscribers(req, res, next) {
  const filter = req.params.filter;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (filter.startsWith("byEmail:")) {
      const email = filter.replace("byEmail:", "");
      return sendPaginatedResults({
        res,
        model: NewsletterSubscriber,
        query: { email: { $regex: new RegExp(email, "i") } },
        sort: { createdAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (filter === "all") {
      return sendPaginatedResults({
        res,
        model: NewsletterSubscriber,
        query: {},
        sort: { createdAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: NewsletterSubscriber,
      query: { status: filter },
      sort: { createdAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

async function updateNewsletterStatus(req, res, next) {
  const { status } = req.body;

  try {
    if (!["Active", "Unsubscribed"].includes(status)) {
      return res.status(400).json({ error: "Invalid newsletter status" });
    }

    const subscriber = await NewsletterSubscriber.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    res.status(200).json(subscriber);
  } catch (error) {
    next(error);
  }
}

async function deleteNewsletterSubscriber(req, res, next) {
  try {
    const deleted = await NewsletterSubscriber.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    res.status(200).json(deleted);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createNewsletterSubscriber,
  getAdminNewsletterSubscribers,
  updateNewsletterStatus,
  deleteNewsletterSubscriber,
};
