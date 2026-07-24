const { connectToDb } = require("../../database");
const AddForm = require("../models/addForm.model");
const {
  getAdminListPagination,
  sendPaginatedResults,
} = require("../utils/pagination");
const { escapeRegex } = require("../utils/regex");

const { Resend } = require("resend");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const wholesaleEmailFrom = process.env.EMAIL_FROM;

const wholesaleFormSubmit = async (req, res, next) => {
  const addForm = req.body;

  try {
    const newAddForm = new AddForm(addForm);

    await newAddForm.save();

    await resend.emails.send({
      from: wholesaleEmailFrom,
      to: [adminNotificationEmail],
      subject: "Whole-sale form submitted !!",
      html: `<strong>Whole-sale customer query from!</strong>
      </br>
       <h2>Wholesale query form submitted by <strong>${escapeHtml(addForm?.name)} </strong></h2>
       </br>
       <p><strong>Name: </strong> ${escapeHtml(addForm?.name)}</p> </br>
       <p><strong>Email: </strong> ${escapeHtml(addForm?.email)}</p> </br>
       <p><strong>Phone number: </strong> ${escapeHtml(addForm?.phone)}</p> </br>
       <p><strong>Devices: </strong> ${escapeHtml(addForm?.devices)}</p> </br>

    </br> `,
    });

    res.status(200).json(newAddForm);
  } catch (error) {
    next(error);
  }
};

async function getAdminAddForms(req, res, next) {
  const filter = req.params.filter;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (filter && filter.startsWith("byEmail:")) {
      const email = filter.replace("byEmail:", "");
      return sendPaginatedResults({
        res,
        model: AddForm,
        query: { email: { $regex: new RegExp(escapeRegex(email), "i") } },
        sort: { createdAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: AddForm,
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

async function deleteAddForm(req, res, next) {
  try {
    const deleted = await AddForm.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Wholesale submission not found" });
    }

    res.status(200).json(deleted);
  } catch (error) {
    next(error);
  }
}

module.exports = { wholesaleFormSubmit, getAdminAddForms, deleteAddForm };
