const ContactSubmission = require("../models/contactSubmission.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");

async function createContactSubmission(req, res, next) {
  try {
    const submission = await ContactSubmission.create(req.body);
    res.status(201).json(submission);
  } catch (error) {
    next(error);
  }
}

async function getAdminContactSubmissions(req, res, next) {
  const filter = req.params.filter;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (filter.startsWith("byEmail:")) {
      const email = filter.replace("byEmail:", "");
      return sendPaginatedResults({
        res,
        model: ContactSubmission,
        query: { email: { $regex: new RegExp(email, "i") } },
        sort: { createdAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (filter === "all") {
      return sendPaginatedResults({
        res,
        model: ContactSubmission,
        query: {},
        sort: { createdAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: ContactSubmission,
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

async function updateContactSubmissionStatus(req, res, next) {
  const { status } = req.body;

  try {
    if (!["New", "Resolved"].includes(status)) {
      return res.status(400).json({ error: "Invalid contact submission status" });
    }

    const updated = await ContactSubmission.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Contact submission not found" });
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
}

async function deleteContactSubmission(req, res, next) {
  try {
    const deleted = await ContactSubmission.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Contact submission not found" });
    }

    res.status(200).json(deleted);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createContactSubmission,
  getAdminContactSubmissions,
  updateContactSubmissionStatus,
  deleteContactSubmission,
};
