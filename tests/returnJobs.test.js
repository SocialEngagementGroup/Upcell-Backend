const {
  sendDueReminders,
  expireStaleAuthorisations,
  autoDeclineStaleOffers,
} = require("../src/services/returnJobs");

const now = new Date("2026-09-20T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
const daysAhead = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

const request = (overrides = {}) => ({
  _id: "req1",
  email: "buyer@example.com",
  orderId: "order1",
  rmaNumber: "RMA-2026-00412",
  status: "LabelIssued",
  timeline: [],
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

const modelReturning = (docs) => ({ find: jest.fn().mockResolvedValue(docs) });
const buildEmail = jest.fn((args) => ({ subject: "x", html: "y", args }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("sendDueReminders", () => {
  const awaiting = (daysSinceIssue, remindersSent = []) => request({
    rma: {
      issuedAt: daysAgo(daysSinceIssue),
      expiresAt: daysAhead(14 - daysSinceIssue),
      remindersSent,
    },
  });

  it("sends nothing before day 7", async () => {
    const sendEmail = jest.fn();

    const result = await sendDueReminders({
      RefundRequest: modelReturning([awaiting(5)]), sendEmail, buildEmail, now,
    });

    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends the day-7 nudge", async () => {
    const doc = awaiting(7);
    const sendEmail = jest.fn();

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail, buildEmail, now });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(buildEmail.mock.calls[0][0].daysLeft).toBe(7);
  });

  it("records which reminder went out, so a re-run does not repeat it", async () => {
    const doc = awaiting(7);

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now });

    expect(doc.rma.remindersSent).toEqual([7]);
    expect(doc.save).toHaveBeenCalled();
  });

  it("does not send one that has already gone", async () => {
    const sendEmail = jest.fn();

    await sendDueReminders({
      RefundRequest: modelReturning([awaiting(8, [7])]), sendEmail, buildEmail, now,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends only the latest when the job has not run for days", async () => {
    // Day 7 followed by day 12 tomorrow is two emails about one deadline, the
    // first already stale.
    const doc = awaiting(13);

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now });

    expect(doc.rma.remindersSent).toEqual([12]);
  });

  it("writes the send into the timeline as the system, not a person", async () => {
    const doc = awaiting(7);

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now });

    expect(doc.timeline.at(-1)).toMatchObject({ event: "reminder_sent", actorType: "system" });
  });

  it("saves before sending, so a crash cannot email the same person daily", async () => {
    const doc = awaiting(7);
    const order = [];
    doc.save.mockImplementation(async () => order.push("save"));
    const sendEmail = jest.fn(() => order.push("send"));

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail, buildEmail, now });

    expect(order).toEqual(["save", "send"]);
  });

  it("only looks at returns the customer still has", async () => {
    const RefundRequest = modelReturning([]);

    await sendDueReminders({ RefundRequest, sendEmail: jest.fn(), buildEmail, now });

    expect(RefundRequest.find.mock.calls[0][0].status.$in)
      .toEqual(["ReturnApproved", "LabelIssued"]);
  });

  it("passes the label through, since printing it is the thing to do next", async () => {
    const doc = awaiting(7);
    doc.shipping = { inbound: { labelUrl: "https://cdn/label.pdf", trackingNumber: "T1" } };

    await sendDueReminders({ RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now });

    expect(buildEmail.mock.calls[0][0].labelUrl).toBe("https://cdn/label.pdf");
  });
});

describe("expireStaleAuthorisations", () => {
  const lapsed = (overrides = {}) => request({
    rma: { issuedAt: daysAgo(20), expiresAt: daysAgo(6), remindersSent: [7, 12] },
    ...overrides,
  });

  it("expires a return the customer never posted", async () => {
    const doc = lapsed();

    const result = await expireStaleAuthorisations({
      RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now,
    });

    expect(result.expired).toBe(1);
    expect(doc.status).toBe("Expired");
    expect(doc.resolution.outcome).toBe("EXPIRED");
  });

  it("attributes it to the system", async () => {
    const doc = lapsed();

    await expireStaleAuthorisations({
      RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now,
    });

    expect(doc.timeline.at(-1)).toMatchObject({
      event: "authorisation_expired", actorType: "system", to: "Expired",
    });
  });

  it("tells the customer how to start again", async () => {
    const sendEmail = jest.fn();

    await expireStaleAuthorisations({
      RefundRequest: modelReturning([lapsed()]), sendEmail, buildEmail, now,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves one whose deadline has not passed", async () => {
    const doc = request({ rma: { issuedAt: daysAgo(2), expiresAt: daysAhead(12) } });

    const result = await expireStaleAuthorisations({
      RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now,
    });

    expect(result.expired).toBe(0);
    expect(doc.status).toBe("LabelIssued");
  });

  it("never expires a return UpCell already has", async () => {
    // The phone is here; the authorisation has done its job.
    const RefundRequest = modelReturning([]);

    await expireStaleAuthorisations({ RefundRequest, sendEmail: jest.fn(), buildEmail, now });

    const statuses = RefundRequest.find.mock.calls[0][0].status.$in;
    expect(statuses).not.toContain("DeviceReceived");
    expect(statuses).not.toContain("InInspection");
  });

  it("skips one the transition map will not allow, rather than forcing it", async () => {
    const doc = lapsed({ status: "Refunded" });

    const result = await expireStaleAuthorisations({
      RefundRequest: modelReturning([doc]), sendEmail: jest.fn(), buildEmail, now,
    });

    expect(result.expired).toBe(0);
    expect(doc.status).toBe("Refunded");
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe("autoDeclineStaleOffers", () => {
  const offered = (expiresAt, status = "RevisedOffer") => request({
    status,
    refundBreakdown: { offeredAmount: 700, offerExpiresAt: expiresAt },
  });

  it("declines an offer nobody answered", async () => {
    // Silence is a decline, and declining sends the device back rather than
    // quietly keeping the customer's phone.
    const doc = offered(daysAgo(1));

    const result = await autoDeclineStaleOffers({ RefundRequest: modelReturning([doc]), now });

    expect(result.declined).toBe(1);
    expect(doc.status).toBe("Rejected");
    expect(doc.resolution.outcome).toBe("PARTIAL_DECLINED");
  });

  it("says why, so the customer is not left guessing", async () => {
    const doc = offered(daysAgo(1));

    await autoDeclineStaleOffers({ RefundRequest: modelReturning([doc]), now });

    expect(doc.rejectionReason).toMatch(/expired without an answer/i);
  });

  it("attributes it to the system", async () => {
    const doc = offered(daysAgo(1));

    await autoDeclineStaleOffers({ RefundRequest: modelReturning([doc]), now });

    expect(doc.timeline.at(-1)).toMatchObject({
      event: "revised_offer_expired", actorType: "system",
    });
  });

  it("leaves one still inside its five days", async () => {
    const doc = offered(daysAhead(2));

    const result = await autoDeclineStaleOffers({ RefundRequest: modelReturning([doc]), now });

    expect(result.declined).toBe(0);
    expect(doc.status).toBe("RevisedOffer");
  });

  it("leaves one the customer already answered", async () => {
    const doc = offered(daysAgo(1), "Approved");

    const result = await autoDeclineStaleOffers({ RefundRequest: modelReturning([doc]), now });

    expect(result.declined).toBe(0);
    expect(doc.status).toBe("Approved");
  });
});
