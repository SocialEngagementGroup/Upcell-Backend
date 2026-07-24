const { adminErrorAlertEmail } = require("../src/services/emailTemplates");

describe("adminErrorAlertEmail — non-technical, non-alarming admin notice", () => {
  it("returns a calm subject line, not an 'ERROR'/'CRASH'-style one", () => {
    const { subject } = adminErrorAlertEmail();
    expect(subject.toLowerCase()).not.toMatch(/error|crash|fail|down/);
  });

  it("renders full HTML with the soft copy, and no technical jargon a non-technical admin would find alarming", () => {
    const { html } = adminErrorAlertEmail();

    expect(html).toContain("A little hiccup on the site");
    expect(html).toContain("No action needed from you right now");

    // This template takes no error/request info as input at all, so there's
    // no way for a stack trace, file path, or raw exception message to leak
    // into it — but assert the alarming vocabulary stays out too.
    expect(html.toLowerCase()).not.toMatch(/stack trace|exception|\.js:\d|at \w+\.\w+ \(/);
  });

  it("takes no arguments — nothing caller-supplied (like err.message) can flow into the email body", () => {
    expect(adminErrorAlertEmail.length).toBe(0);
  });
});
