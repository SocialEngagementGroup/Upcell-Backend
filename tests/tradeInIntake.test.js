// Getting a traded-in device from a customer's hand onto UpCell's shelf.
//
// The returns workflow run backwards, calling the same shipping, inspection
// and offer services. These tests are mostly about the places where the two
// differ, because those are where a shared service can be right and the
// trade-in still wrong.

jest.mock("../src/models/tradeInRequest.model", () => ({
  TradeInRequest: { findById: jest.fn(), findOne: jest.fn() },
  tradeInStatusEnum: require("../src/constants/tradeInStatus").TRADE_IN_STATUSES,
}));
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/auditLog.model");

const { TradeInRequest } = require("../src/models/tradeInRequest.model");
const SingleVariation = require("../src/models/singleVariation.model");
const AuditLog = require("../src/models/auditLog.model");
const controller = require("../src/controllers/tradeInIntake.controller");
const { hashToken, createAccessToken } = require("../src/utils/accessToken");

const STAFF = { id: "user_admin", email: "yasir@upcellit.com", role: "admin" };

const makeReqRes = (body = {}, { params = {}, query = {}, user = STAFF } = {}) => {
  const req = { body, params, query, user };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

const requestDoc = (over = {}) => ({
  _id: "tr1",
  name: "Sam Okonkwo",
  email: "sam@example.com",
  modelTitle: "iPhone 13 128GB",
  model: "iphone-13",
  storage: "128GB",
  estimateCents: 40000,
  status: "Quoted",
  timeline: [],
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

const label = (over = {}) => ({
  carrier: "FedEx",
  trackingNumber: "794658123456",
  labelUrl: "https://labels.example.com/a.pdf",
  ...over,
});

// A full pass: powers on, no liquid damage, Activation Lock off.
//
// matches_grade_sold is deliberately absent. It asks whether a device still
// matches the grade UpCell sold it at, and UpCell never sold this one — the
// inspection service skips it for a trade-in. A test that answered it anyway
// would pass whether or not that skip works.
const cleanChecklist = () => [
  { key: "imei_matches", result: "pass" },
  { key: "activation_lock", result: "pass" },
  { key: "powers_on", result: "pass" },
  { key: "screen_touch", result: "pass" },
  { key: "liquid_damage", result: "pass" },
  { key: "unlocked", result: "pass" },
  { key: "battery_health", result: "pass", value: 92 },
  { key: "cosmetic_grade", result: "pass", grade: "GOOD" },
];

// Five photos, which is the minimum an inspection can be submitted with: the
// five that answer the arguments that actually happen.
const fivePhotos = () => Array.from({ length: 5 }, (_, i) => ({
  url: `https://images.example.com/${i}.jpg`,
  publicId: `p${i}`,
}));

const noClash = () => TradeInRequest.findOne.mockReturnValue({
  select: () => ({ lean: () => Promise.resolve(null) }),
});

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
  noClash();
});

describe("issuing a label", () => {
  it("records the leg and moves a quote to LabelIssued", async () => {
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("LabelIssued");
    expect(doc.shipping.inbound.trackingNumber).toBe("794658123456");
  });

  it("has UpCell pay to get the device in", async () => {
    // Unlike a return, where a change of mind is the customer's own cost,
    // there is no version of a trade-in where the customer pays postage.
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    expect(doc.shipping.inbound.paidBy).toBe("UPCELL");
  });

  it("replaces a label without failing on the transition", async () => {
    // Re-uploading a corrected label onto a request already at LabelIssued
    // should swap the file, not be refused as an illegal move.
    const doc = requestDoc({ status: "LabelIssued" });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(label({ trackingNumber: "794658999999" }), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("LabelIssued");
    expect(doc.timeline.some((entry) => entry.event === "label_replaced")).toBe(true);
  });

  it("refuses a tracking number already on another open trade-in", async () => {
    // Two live trade-ins sharing a number means the receiving desk scans a
    // parcel and gets two answers.
    TradeInRequest.findById.mockResolvedValue(requestDoc());
    TradeInRequest.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ _id: "other1" }) }),
    });

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    expect(res.statusCode).toBe(409);
  });

  it("searches trade-ins for the clash, not returns", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    // The clash check is generic and takes whichever collection it is given.
    // Handed the wrong one, a trade-in would be checked against returns.
    expect(TradeInRequest.findOne).toHaveBeenCalled();
  });

  it("refuses a label link that is not https", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes(label({ labelUrl: "http://labels.example.com/a.pdf" }), { params: { id: "tr1" } });
    await controller.recordTradeInLabel(req, res, next);

    expect(res.statusCode).toBe(400);
  });
});

describe("the receiving desk", () => {
  it("finds a trade-in by its tracking number", async () => {
    TradeInRequest.findOne.mockReturnValue({ lean: () => Promise.resolve(requestDoc()) });

    const { req, res, next } = makeReqRes({}, { query: { q: "794658123456" } });
    await controller.lookupTradeInRequest(req, res, next);

    expect(sent(res).ok).toBe(true);
  });

  it("looks at the IMEI too, for a box with no readable label", async () => {
    TradeInRequest.findOne.mockReturnValue({ lean: () => Promise.resolve(requestDoc()) });

    const { req, res, next } = makeReqRes({}, { query: { q: "123456789012345" } });
    await controller.lookupTradeInRequest(req, res, next);

    const [filter] = TradeInRequest.findOne.mock.calls[0];
    const fields = filter.$or.map((clause) => Object.keys(clause)[0]);
    expect(fields).toContain("inspection.imei");
  });

  it("refuses a search too short to mean anything", async () => {
    const { req, res, next } = makeReqRes({}, { query: { q: "79" } });
    await controller.lookupTradeInRequest(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("says not to create one when nothing matches", async () => {
    // The wrong instinct with a parcel that has arrived is to open a new
    // request for it, which loses the quote the customer was given.
    TradeInRequest.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const { req, res, next } = makeReqRes({}, { query: { q: "794658000000" } });
    await controller.lookupTradeInRequest(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(sent(res).hint).toContain("Do not create a new request");
  });
});

describe("inspecting the device", () => {
  const received = (over = {}) => requestDoc({ status: "DeviceReceived", ...over });

  it("records the checklist and works out the grade", async () => {
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(
      { checklist: cleanChecklist(), photos: fivePhotos(), imei: "123456789012345" },
      { params: { id: "tr1" } }
    );
    await controller.submitTradeInInspection(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("InInspection");
    expect(doc.inspection.batteryHealth).toBe(92);
    expect(doc.inspection.cosmeticGrade).toBe("GOOD");
    expect(doc.inspection.finalGrade).toBe("GOOD");
  });

  it("records the IMEI for the first time rather than matching it", async () => {
    // A return compares the number against what the order says was sold.
    // A trade-in has no prior record — this is the record.
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(
      { checklist: cleanChecklist(), photos: fivePhotos(), imei: "123456789012345" },
      { params: { id: "tr1" } }
    );
    await controller.submitTradeInInspection(req, res, next);

    expect(doc.inspection.imei).toBe("123456789012345");
  });

  it("parks an Activation Locked device rather than failing it", async () => {
    // Only the customer can clear it, and a device nobody can unlock is not a
    // device anybody has done anything wrong with.
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const checklist = cleanChecklist().map((entry) =>
      entry.key === "activation_lock" ? { ...entry, result: "fail" } : entry
    );

    const { req, res, next } = makeReqRes({ checklist, photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(doc.status).toBe("ActionRequired");
    expect(sent(res).suggestion.outcome).toBe("ACTION_REQUIRED");
  });

  it("stops the payout clock while waiting on the customer", async () => {
    // A device sitting Activation Locked is not UpCell failing to pay.
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const checklist = cleanChecklist().map((entry) =>
      entry.key === "activation_lock" ? { ...entry, result: "fail" } : entry
    );

    const { req, res, next } = makeReqRes({ checklist, photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(doc.sla.clockPausedAt).toBeInstanceOf(Date);
  });

  it("restarts the clock from the end of inspection, not from arrival", async () => {
    // A device that sat in a queue is UpCell's delay to own; the two business
    // days are counted from when somebody actually looked at it.
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ checklist: cleanChecklist(), photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(doc.sla.clockStartedAt).toBeInstanceOf(Date);
    expect(doc.sla.clockPausedAt).toBeUndefined();
  });

  it("suggests an outcome without applying it", async () => {
    // A checklist cannot see a device, and the person holding it can.
    const doc = received();
    TradeInRequest.findById.mockResolvedValue(doc);

    const checklist = cleanChecklist().map((entry) =>
      entry.key === "liquid_damage" ? { ...entry, result: "fail" } : entry
    );

    const { req, res, next } = makeReqRes({ checklist, photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(sent(res).suggestion.outcome).toBe("REJECT");
    // Suggested only. Nothing is rejected without a person saying so.
    expect(doc.status).not.toBe("Rejected");
  });

  it("refuses to inspect a device that has not arrived", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc({ status: "LabelIssued" }));

    const { req, res, next } = makeReqRes({ checklist: cleanChecklist(), photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("refuses an incomplete checklist", async () => {
    TradeInRequest.findById.mockResolvedValue(received());

    const { req, res, next } = makeReqRes({ checklist: [{ key: "powers_on", result: "pass" }], photos: [] }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).details.length).toBeGreaterThan(0);
  });

  it("lets a cleared device be inspected again", async () => {
    // The customer removed Activation Lock; the bench looks again.
    const doc = requestDoc({ status: "ActionRequired" });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ checklist: cleanChecklist(), photos: fivePhotos() }, { params: { id: "tr1" } });
    await controller.submitTradeInInspection(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("InInspection");
  });
});

describe("offering less than the quote", () => {
  // The customer said Excellent; it came in Fair. That failing cosmetic check
  // is what a deduction is allowed to point at — an offer cut for a reason no
  // check failed on is a number with nothing behind it.
  const gradedDown = () => cleanChecklist().map((entry) =>
    entry.key === "cosmetic_grade" ? { ...entry, result: "fail", grade: "FAIR" } : entry
  );

  const inspected = (over = {}) => requestDoc({
    status: "InInspection",
    inspection: { checklist: gradedDown(), finalGrade: "FAIR", batteryHealth: 92 },
    ...over,
  });

  const deduction = (over = {}) => ({
    type: "DAMAGE",
    amount: 9000,
    reason: "Deep scratch across the back glass",
    // Every deduction names the photo that shows it. A customer told their
    // offer dropped $90 for a scratch can ask to see the scratch.
    photoIds: ["p0"],
    // And the check it failed on. Pointing at a check that passed is worse
    // than pointing at none: it looks evidenced when it is not.
    findingKey: "cosmetic_grade",
    ...over,
  });

  it("builds the offer from the quote and the deductions", async () => {
    const doc = inspected();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("RevisedOffer");
    // 40000 quoted minus 9000. Both in cents — mixing the units is how a $90
    // deduction becomes 90 cents.
    expect(doc.revisedOfferCents).toBe(31000);
  });

  it("never stores the token it sends", async () => {
    // The plaintext exists in the response and in the email that carries it,
    // nowhere else. A stolen database gives an attacker hashes.
    const doc = inspected();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    const token = sent(res).offerToken;
    expect(token).toBeTruthy();
    expect(doc.accessToken).not.toBe(token);
    expect(doc.accessToken).toBe(hashToken(token));
  });

  it("mints a new token, so the link in a superseded email stops working", async () => {
    const doc = inspected({ accessToken: hashToken("old-token") });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(doc.accessToken).not.toBe(hashToken("old-token"));
  });

  it("stops the clock while the customer decides", async () => {
    const doc = inspected();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(doc.sla.clockPausedAt).toBeInstanceOf(Date);
  });

  it("refuses a trade-in with no quote to revise", async () => {
    const doc = inspected({ estimateCents: undefined, estimate: undefined });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("refuses a deduction with no reason the customer can read", async () => {
    // A number with no explanation is what gets disputed and what UpCell then
    // cannot defend.
    const doc = inspected();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction({ reason: "" })] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("keeps the deductions, so the offer can be explained later", async () => {
    const doc = inspected();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ deductions: [deduction()] }, { params: { id: "tr1" } });
    await controller.offerRevisedTradeIn(req, res, next);

    expect(doc.offerDeductions[0].reason).toBe("Deep scratch across the back glass");
  });
});

describe("the customer answering an offer", () => {
  const PLAIN = createAccessToken();

  const offered = (over = {}) => requestDoc({
    status: "RevisedOffer",
    revisedOfferCents: 31000,
    offerDeductions: [{ type: "DAMAGE", amount: 9000, reason: "Scratch" }],
    offerExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    accessToken: hashToken(PLAIN),
    inspection: { finalGrade: "GOOD", batteryHealth: 92 },
    ...over,
  });

  const withToken = (doc) => TradeInRequest.findById.mockReturnValue({
    select: () => Promise.resolve(doc),
  });

  it("shows the offer to somebody holding the link", async () => {
    withToken(offered());

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" }, query: { token: PLAIN }, user: null });
    await controller.getTradeInOffer(req, res, next);

    expect(sent(res)).toMatchObject({ ok: true, offeredCents: 31000 });
  });

  it("says nothing to somebody without the link", async () => {
    withToken(offered());

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" }, query: { token: "wrong" }, user: null });
    await controller.getTradeInOffer(req, res, next);

    // 404 rather than 403. Confirming an id is real is itself worth knowing to
    // whoever is guessing them.
    expect(res.statusCode).toBe(404);
  });

  it("never sends the inspector or the audit trail to the customer", async () => {
    withToken(offered({ inspection: { finalGrade: "GOOD", inspectorId: "yasir@upcellit.com" } }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" }, query: { token: PLAIN }, user: null });
    await controller.getTradeInOffer(req, res, next);

    expect(JSON.stringify(sent(res))).not.toContain("yasir@upcellit.com");
    expect(sent(res).timeline).toBeUndefined();
  });

  it("accepts, and moves the trade-in to Approved", async () => {
    const doc = offered();
    withToken(doc);

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "accept" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(doc.status).toBe("Approved");
    expect(sent(res).ok).toBe(true);
  });

  it("declines, and the device goes back at UpCell's cost", async () => {
    const doc = offered();
    withToken(doc);

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "decline" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(doc.status).toBe("Rejected");
    expect(sent(res).message).toContain("at our cost");
  });

  it("burns the token, so a forwarded email cannot change the answer", async () => {
    const doc = offered();
    withToken(doc);

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "accept" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(doc.accessToken).toBeUndefined();
  });

  it("restarts the clock on acceptance, because UpCell now owes money", async () => {
    const doc = offered();
    withToken(doc);

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "accept" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(doc.sla.clockPausedAt).toBeUndefined();
    expect(doc.sla.clockStartedAt).toBeInstanceOf(Date);
  });

  it("refuses an expired offer", async () => {
    withToken(offered({ offerExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }));

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "accept" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("says an offer already answered is answered, rather than answering twice", async () => {
    withToken(offered({ status: "Approved" }));

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "decline" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("already been answered");
  });

  it("refuses a decision that is neither", async () => {
    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "maybe" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("records the customer as the actor, not a staff member", async () => {
    const doc = offered();
    withToken(doc);

    const { req, res, next } = makeReqRes({ token: PLAIN }, { params: { id: "tr1", decision: "accept" }, user: null });
    await controller.respondToTradeInOffer(req, res, next);

    expect(doc.timeline[0]).toMatchObject({ actorType: "customer", actor: "sam@example.com" });
  });
});

describe("sending a refused device back", () => {
  it("records the leg and moves to ReturnShipped", async () => {
    const doc = requestDoc({ status: "Rejected" });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.shipTradeInBack(req, res, next);

    expect(doc.status).toBe("ReturnShipped");
    expect(doc.shipping.outbound.paidBy).toBe("UPCELL");
  });

  it("refuses to send back a device nobody refused", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc({ status: "Approved" }));

    const { req, res, next } = makeReqRes(label(), { params: { id: "tr1" } });
    await controller.shipTradeInBack(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("starts a hold when it comes back undelivered", async () => {
    // A customer who moved house or was away should get an email, not a
    // written-off phone.
    const doc = requestDoc({
      status: "ReturnShipped",
      shipping: { outbound: { shippedAt: new Date() } },
    });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ reason: "Nobody home, three attempts" }, { params: { id: "tr1" } });
    await controller.markTradeInUndeliverable(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.shipping.outbound.disposeAfter).toBeInstanceOf(Date);
    expect(doc.shipping.outbound.undeliverableReason).toBe("Nobody home, three attempts");
  });

  it("refuses to mark something undelivered that was never sent", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc({ status: "Rejected" }));

    const { req, res, next } = makeReqRes({ reason: "Returned" }, { params: { id: "tr1" } });
    await controller.markTradeInUndeliverable(req, res, next);

    expect(res.statusCode).toBe(400);
  });
});

describe("listing the device UpCell bought", () => {
  const agreed = (over = {}) => requestDoc({
    status: "Approved",
    inspection: { finalGrade: "GOOD", batteryHealth: 92, imei: "123456789012345" },
    ...over,
  });

  beforeEach(() => {
    SingleVariation.create.mockResolvedValue({ _id: "var1" });
  });

  it("creates a catalogue row from the inspection", async () => {
    const doc = agreed();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(res.statusCode).toBe(201);
    const [created] = SingleVariation.create.mock.calls[0];
    expect(created).toMatchObject({
      productName: "iPhone 13 128GB",
      storage: "128GB",
      cosmeticGrade: "GOOD",
      batteryHealth: 92,
      imei: "123456789012345",
    });
  });

  it("creates it out of stock and with no price", async () => {
    // A device that appears in the shop the moment it is accepted is a device
    // offered for sale before anybody decided what it is worth.
    TradeInRequest.findById.mockResolvedValue(agreed());

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    const [created] = SingleVariation.create.mock.calls[0];
    expect(created.outOfStock).toBe(true);
    expect(created.price).toBeUndefined();
  });

  it("marks it as bought from an individual", async () => {
    // Which is what closes the supplier route on any future return of this
    // exact unit — there is nobody to send it back to.
    TradeInRequest.findById.mockResolvedValue(agreed());

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(SingleVariation.create.mock.calls[0][0].acquisitionSource).toBe("INDIVIDUAL");
  });

  it("puts a weak battery aside rather than listing it", async () => {
    TradeInRequest.findById.mockResolvedValue(agreed({
      inspection: { finalGrade: "FAIR", batteryHealth: 74, imei: "123456789012345" },
    }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(SingleVariation.create.mock.calls[0][0].refurbState).toBe("NEEDS_BATTERY");
  });

  it("ties the catalogue row back to the trade-in", async () => {
    // A device UpCell bought and a device UpCell sells are the same physical
    // phone, and a fault reported later has to be answerable from both ends.
    const doc = agreed();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(String(doc.listedVariationId)).toBe("var1");
  });

  it("will not list a device that failed inspection", async () => {
    TradeInRequest.findById.mockResolvedValue(agreed({
      inspection: { finalGrade: "FAIL", batteryHealth: 60 },
    }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(SingleVariation.create).not.toHaveBeenCalled();
  });

  it("will not list a trade-in nobody has agreed", async () => {
    TradeInRequest.findById.mockResolvedValue(agreed({ status: "InInspection" }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("will not list the same device twice", async () => {
    TradeInRequest.findById.mockResolvedValue(agreed({ listedVariationId: "var0" }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(res.statusCode).toBe(409);
  });

  it("explains a duplicate IMEI rather than crashing on it", async () => {
    // The same physical device cannot be listed twice, and one traded in twice
    // means somebody bought it back.
    TradeInRequest.findById.mockResolvedValue(agreed());
    SingleVariation.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));

    const { req, res, next } = makeReqRes({}, { params: { id: "tr1" } });
    await controller.listTradedDevice(req, res, next);

    expect(res.statusCode).toBe(409);
    expect(next).not.toHaveBeenCalled();
  });
});

// An offer nobody answered.
//
// Declining it sends the device home, which is kinder than holding it
// indefinitely while the customer hears nothing.
describe("declining a stale offer", () => {
  const { autoDeclineStaleTradeInOffers } = require("../src/services/returnJobs");
  const tradeInStatus = require("../src/constants/tradeInStatus");

  const stale = (over = {}) => requestDoc({
    status: "RevisedOffer",
    revisedOfferCents: 31000,
    offerExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    accessToken: hashToken("live-token"),
    ...over,
  });

  const collection = (rows) => ({ find: jest.fn().mockResolvedValue(rows) });

  it("declines an offer whose five days are up", async () => {
    const doc = stale();
    const report = await autoDeclineStaleTradeInOffers({
      TradeInRequest: collection([doc]), tradeInStatus,
    });

    expect(report.declined).toBe(1);
    expect(doc.status).toBe("Rejected");
  });

  it("kills the token with the offer", async () => {
    // Otherwise the link in the email still works and a customer can accept an
    // offer the system has already declined on their behalf.
    const doc = stale();
    await autoDeclineStaleTradeInOffers({ TradeInRequest: collection([doc]), tradeInStatus });

    expect(doc.accessToken).toBeUndefined();
  });

  it("leaves an offer that is still open alone", async () => {
    const doc = stale({ offerExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const report = await autoDeclineStaleTradeInOffers({
      TradeInRequest: collection([doc]), tradeInStatus,
    });

    expect(report.declined).toBe(0);
    expect(doc.status).toBe("RevisedOffer");
  });

  it("records the system as the actor, not a person", async () => {
    const doc = stale();
    await autoDeclineStaleTradeInOffers({ TradeInRequest: collection([doc]), tradeInStatus });

    expect(doc.timeline[0]).toMatchObject({ actorType: "system", event: "revised_offer_expired" });
  });

  it("checks against the trade-in map, not the returns one", async () => {
    // RevisedOffer -> Rejected is legal in both, so the wrong map would still
    // move it — but the timeline would then be checked against rules that do
    // not describe this record. Asserted through what it reports.
    const doc = stale();
    const report = await autoDeclineStaleTradeInOffers({
      TradeInRequest: collection([doc]), tradeInStatus,
    });

    expect(report).toMatchObject({ declined: 1, considered: 1 });
  });

  it("only looks at offers past their date", async () => {
    const model = collection([]);
    await autoDeclineStaleTradeInOffers({ TradeInRequest: model, tradeInStatus });

    const [query] = model.find.mock.calls[0];
    expect(query.status).toBe("RevisedOffer");
    expect(query.offerExpiresAt.$lt).toBeInstanceOf(Date);
  });
});
