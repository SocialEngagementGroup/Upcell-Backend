const ContactSubmission = require("../models/contactSubmission.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");
const { escapeRegex } = require("../utils/regex");
const { Notification } = require("../models/notification.model");
const { EmailConfig } = require("../models/emailConfig.model");
const { sendMail } = require("../services/mailService");
const { adminNewContactEmail } = require("../services/emailTemplates");

const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const contactEmailFrom = process.env.EMAIL_FROM;

// Tell the admin a message arrived, by email and in the dashboard bell.
//
// Nothing did this before: a contact submission was written to the database and
// no one was informed, so a customer's message sat unread until somebody
// happened to open the contact page. The notification type "contact" was
// already in the model's enum, waiting for this.
//
// Fire-and-forget, and never allowed to reject. The customer's message is
// already saved by the time this runs, so a mail outage must not turn a
// successful submission into an error on their screen.
async function notifyNewContact(submission) {
  try {
    const config = await EmailConfig.findOne().lean();

    // Same switch that mutes trade-in admin mail, so one control silences
    // outbound noise while someone is testing.
    if (adminNotificationEmail && contactEmailFrom && config?.enableAdminEmails !== false) {
      const { subject, html } = adminNewContactEmail({
        name: submission.name,
        email: submission.email,
        subject: submission.subject,
        message: submission.message,
        submissionId: submission._id,
      });

      await sendMail({
        from: contactEmailFrom,
        to: adminNotificationEmail,
        subject,
        html,
      });
    }

    await Notification.create({
      type: "contact",
      title: "New contact message",
      message: `${submission.name} sent a message: ${submission.subject}`,
      link: "/admin-secret/contact",
      relatedId: submission._id,
    });
  } catch (error) {
    console.error("[contact] failed to notify admin:", error?.message || error);
  }
}

async function createContactSubmission(req, res, next) {
  try {
    const submission = await ContactSubmission.create(req.body);
    res.status(201).json(submission);

    // After responding, deliberately. The customer should not wait on our
    // outbound email, and should not see a failure if it does not send.
    notifyNewContact(submission);
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
        query: { email: { $regex: new RegExp(escapeRegex(email), "i") } },
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
