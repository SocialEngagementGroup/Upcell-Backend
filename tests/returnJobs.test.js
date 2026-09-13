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

describe("purgeInspectionPhotos", () => {
  const { purgeInspectionPhotos, photosAreHeld } = require("../src/services/returnJobs");

  const photo = (id, purgeAfter) => ({ publicId: id, url: `https://cdn/${id}.jpg`, purgeAfter });

  const withPhotos = (photos, status = "Refunded") => request({
    status,
    inspection: { photos },
  });

  const destroys = () => jest.fn(async () => ({ ok: true, result: "ok" }));

  it("deletes a photo whose ninety days are up", async () => {
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    const destroyAsset = destroys();

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(destroyAsset).toHaveBeenCalledWith("p1");
    expect(result.deleted).toBe(1);
    expect(doc.inspection.photos).toHaveLength(0);
  });

  it("keeps one that is not due yet", async () => {
    const doc = withPhotos([photo("p1", daysAhead(10))]);
    const destroyAsset = destroys();

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset, now });

    expect(destroyAsset).not.toHaveBeenCalled();
    expect(doc.inspection.photos).toHaveLength(1);
  });

  it("deletes only the due ones, leaving the rest", async () => {
    const doc = withPhotos([photo("old", daysAgo(1)), photo("new", daysAhead(30))]);

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset: destroys(), now });

    expect(doc.inspection.photos.map((entry) => entry.publicId)).toEqual(["new"]);
  });

  it("holds everything on a return that went wrong", async () => {
    // Rejected, reduced and shipped-back returns are exactly the ones that turn
    // into an argument months later, and the photos are the only evidence of
    // what actually arrived.
    for (const status of ["Rejected", "ReturnShipped", "RevisedOffer"]) {
      const doc = withPhotos([photo("p1", daysAgo(100))], status);
      const destroyAsset = destroys();

      const result = await purgeInspectionPhotos({
        RefundRequest: modelReturning([doc]), destroyAsset, now,
      });

      expect(destroyAsset).not.toHaveBeenCalled();
      expect(result.held).toBe(1);
      expect(doc.inspection.photos).toHaveLength(1);
    }
  });

  it("keeps the purge date on a held photo, so it is reconsidered when the case closes", async () => {
    const original = daysAgo(100);
    const doc = withPhotos([photo("p1", original)], "Rejected");

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset: destroys(), now });

    expect(doc.inspection.photos[0].purgeAfter).toEqual(original);
  });

  it("keeps a photo whose delete failed, so the next run tries again", async () => {
    // Marking it gone loses the only handle we have on an asset still sitting
    // in the account.
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    const destroyAsset = jest.fn(async () => ({ ok: false, error: "Cloudinary answered 500" }));

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(doc.inspection.photos).toHaveLength(1);
  });

  it("reports the failure rather than looking like a clean run", async () => {
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    const destroyAsset = jest.fn(async () => ({ ok: false, error: "keys missing" }));

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(result.failures[0]).toMatchObject({ publicId: "p1", error: "keys missing" });
  });

  it("still deletes the ones that worked when another fails", async () => {
    const doc = withPhotos([photo("good", daysAgo(1)), photo("bad", daysAgo(1))]);
    const destroyAsset = jest.fn(async (id) =>
      id === "bad" ? { ok: false, error: "boom" } : { ok: true, result: "ok" });

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(result.deleted).toBe(1);
    expect(doc.inspection.photos.map((entry) => entry.publicId)).toEqual(["bad"]);
  });

  it("writes the deletion into the record", async () => {
    // "Where did the photos go" is a question somebody asks.
    const doc = withPhotos([photo("p1", daysAgo(1))]);

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset: destroys(), now });

    expect(doc.timeline.at(-1)).toMatchObject({
      event: "inspection_photos_purged", actorType: "system",
    });
    expect(doc.timeline.at(-1).meta.deleted).toBe(1);
  });

  it("does not save a request it did not change", async () => {
    const doc = withPhotos([photo("p1", daysAhead(10))]);

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset: destroys(), now });

    expect(doc.save).not.toHaveBeenCalled();
  });

  it("skips photos on a request with an accepted or declined revised offer", async () => {
    // The status is Refunded and the case looks closed, but money was
    // withheld — and that is the argument a customer comes back about months
    // later. The offer in the history is the hold, not the current status.
    for (const event of [
      "revised_offer_sent",
      "revised_offer_accepted",
      "revised_offer_declined",
      "revised_offer_expired",
    ]) {
      const doc = withPhotos([photo("p1", daysAgo(100))]);
      doc.timeline = [{ event: "inspection_completed" }, { event }];
      const destroyAsset = destroys();

      const result = await purgeInspectionPhotos({
        RefundRequest: modelReturning([doc]), destroyAsset, now,
      });

      expect(destroyAsset).not.toHaveBeenCalled();
      expect(result.held).toBe(1);
      expect(doc.inspection.photos).toHaveLength(1);
    }
  });

  it("still purges a clean return whose history has no offer in it", async () => {
    // The vacuity check on the rule above: a plain refund is not held.
    const doc = withPhotos([photo("p1", daysAgo(100))]);
    doc.timeline = [{ event: "inspection_completed" }, { event: "refund_issued" }];

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset: destroys(), now,
    });

    expect(result.deleted).toBe(1);
  });

  it("skips photos on a request flagged disputed", async () => {
    // A chargeback or a solicitor's letter. Set by hand, and it outranks
    // everything else, because the moment the photos matter most is the
    // moment somebody is arguing about what arrived.
    const doc = withPhotos([photo("p1", daysAgo(100))]);
    doc.disputed = true;
    const destroyAsset = destroys();

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(destroyAsset).not.toHaveBeenCalled();
    expect(result.held).toBe(1);
    expect(doc.inspection.photos[0].purgeAfter).toEqual(daysAgo(100));
  });

  it("holds for all three reasons, and says which", () => {
    expect(photosAreHeld({ disputed: true }).why).toBe("disputed");
    expect(photosAreHeld({ status: "Rejected" }).why).toBe("status");
    expect(photosAreHeld({ timeline: [{ event: "revised_offer_sent" }] }).why)
      .toBe("revised_offer");
    expect(photosAreHeld({ status: "Refunded", timeline: [] }).held).toBe(false);
  });

  it("retries a failed delete", async () => {
    // A blip should not cost a photo another ninety days on the shelf.
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    let calls = 0;
    const destroyAsset = jest.fn(async () => {
      calls += 1;
      return calls < 3 ? { ok: false, error: "Cloudinary answered 500" } : { ok: true, result: "ok" };
    });

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(destroyAsset).toHaveBeenCalledTimes(3);
    expect(result.deleted).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("does not retry a delete that worked", async () => {
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    const destroyAsset = destroys();

    await purgeInspectionPhotos({ RefundRequest: modelReturning([doc]), destroyAsset, now });

    expect(destroyAsset).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed delete after retries rather than silently skipping it", async () => {
    const doc = withPhotos([photo("p1", daysAgo(1))]);
    const destroyAsset = jest.fn(async () => ({ ok: false, error: "Cloudinary answered 500" }));

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(destroyAsset).toHaveBeenCalledTimes(3);
    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      { requestId: "req1", publicId: "p1", error: "Cloudinary answered 500", refused: false },
    ]);
    expect(doc.inspection.photos).toHaveLength(1);
  });

  it("does not retry a refusal, and counts it apart from a bad day", async () => {
    // A refusal means the id is outside the returns tree. Retrying refuses
    // again, and the interesting fact is that something tried at all.
    const doc = withPhotos([photo("upcell/products/iphone/x", daysAgo(1))]);
    const destroyAsset = jest.fn(async () => ({
      ok: false, refused: true, error: 'Refusing to delete "upcell/products/iphone/x"',
    }));
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await purgeInspectionPhotos({
      RefundRequest: modelReturning([doc]), destroyAsset, now,
    });

    expect(destroyAsset).toHaveBeenCalledTimes(1);
    expect(result.refused).toBe(1);
    expect(result.failures[0].refused).toBe(true);
    expect(doc.inspection.photos).toHaveLength(1);
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
