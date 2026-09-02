process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.com";
process.env.EMAIL_FROM = "noreply@example.com";

const mockSendMail = jest.fn().mockResolvedValue({ sent: true, id: "mail_1" });
jest.mock("../src/services/mailService", () => ({
  sendMail: (...args) => mockSendMail(...args),
  getMessageId: jest.fn(),
}));

jest.mock("../src/models/contactSubmission.model");
jest.mock("../src/models/notification.model", () => ({
  Notification: { create: jest.fn() },
  notificationTypeEnum: ["trade-in", "order", "wholesale", "contact"],
}));
jest.mock("../src/models/emailConfig.model", () => ({
  EmailConfig: { findOne: jest.fn() },
}));

const ContactSubmission = require("../src/models/contactSubmission.model");
const { Notification } = require("../src/models/notification.model");
const { EmailConfig } = require("../src/models/emailConfig.model");
const contact = require("../src/controllers/contact.controller");

const SUBMISSION = {
  _id: "6a79f7298341f33d9a65b0b7",
  name: "Jane Doe",
  email: "jane@example.com",
  subject: "Question about my order",
  message: "Hello, I would like to know when my iPhone will ship.",
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const makeReqRes = (body = {}) => {
  const res = { statusCode: 0, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return { req: { body }, res, next: jest.fn() };
};

beforeEach(() => {
  jest.clearAllMocks();
  ContactSubmission.create.mockResolvedValue(SUBMISSION);
  Notification.create.mockResolvedValue({});
  EmailConfig.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({ enableAdminEmails: true }),
  });
});

describe("a contact message reaches the admin", () => {
  it("emails the admin with the customer's message", async () => {
    // The message used to be saved and nobody told, so it sat unread until an
    // admin happened to open the contact page.
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe("admin@example.com");
    expect(mail.subject).toContain("Question about my order");
    // The message itself, so a reply does not require logging in first.
    expect(mail.html).toContain("when my iPhone will ship");
    expect(mail.html).toContain("jane@example.com");
  });

  it("also raises the dashboard notification", async () => {
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contact", relatedId: SUBMISSION._id })
    );
  });

  it("escapes the customer's text so a message cannot inject markup", async () => {
    ContactSubmission.create.mockResolvedValue({
      ...SUBMISSION,
      name: '<script>alert(1)</script>',
    });
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("notifying must never cost the customer their message", () => {
  it("answers 201 before the email is attempted", async () => {
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);

    // Responded already, without waiting on outbound mail.
    expect(res.statusCode).toBe(201);
    expect(next).not.toHaveBeenCalled();
  });

  it("still succeeds when sending the email fails", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("Resend is down"));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    // The message is saved. A mail outage must not show the customer an error.
    expect(res.statusCode).toBe(201);
    expect(next).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("respects the admin switch that mutes outbound mail during testing", async () => {
    EmailConfig.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ enableAdminEmails: false }),
    });
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    expect(mockSendMail).not.toHaveBeenCalled();
    // The dashboard notification still appears — muting email should not lose
    // the message entirely.
    expect(Notification.create).toHaveBeenCalled();
  });

  it("still records the submission when the database write for the notification fails", async () => {
    Notification.create.mockRejectedValueOnce(new Error("Mongo is down"));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { req, res, next } = makeReqRes(SUBMISSION);

    await contact.createContactSubmission(req, res, next);
    await flush();

    expect(res.statusCode).toBe(201);
    expect(next).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
