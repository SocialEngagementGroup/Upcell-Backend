process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ id: "email_1" }) },
  })),
}));
jest.mock("../src/models/tradeInRequest.model", () => ({
  TradeInRequest: {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  },
  tradeInStatusEnum: require("../src/constants/tradeInStatus").TRADE_IN_STATUSES,
}));
jest.mock("../src/models/auditLog.model");
jest.mock("../src/models/notification.model");
jest.mock("../src/models/emailConfig.model");
jest.mock("../src/models/tradeInPriceBook.model");
jest.mock("../src/models/tradeInQuestion.model");

const { TradeInRequest } = require("../src/models/tradeInRequest.model");
const TradeInPriceBook = require("../src/models/tradeInPriceBook.model");
const TradeInQuestion = require("../src/models/tradeInQuestion.model");
const AuditLog = require("../src/models/auditLog.model");
const { EmailConfig } = require("../src/models/emailConfig.model");
const controller = require("../src/controllers/tradeIn.controller");

const STAFF = { id: "user_admin", email: "yasir@upcellit.com", role: "admin" };

const makeReqRes = (body = {}, { params = {}, user = STAFF } = {}) => {
  const req = { body, params, query: {}, user };
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
  phone: "3132888312",
  modelTitle: "iPhone 13 128GB",
  estimate: 400,
  status: "Quoted",
  timeline: [],
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
  // The notification path runs after the response and is allowed to fail; it
  // is stubbed so a rejected promise does not leak into another test.
  EmailConfig.findOne.mockResolvedValue({ _id: "cfg", enableCustomerEmails: false, enableAdminEmails: false });
  TradeInRequest.findByIdAndUpdate.mockResolvedValue({});
});

// A direct write to `status` skips the transition map, and an illegal state
// reached once stays reached — there is nothing later that puts it back.
describe("moving a trade-in", () => {
  it("makes a legal move and saves it", async () => {
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("LabelIssued");
    expect(doc.save).toHaveBeenCalled();
  });

  it("refuses an illegal move and changes nothing", async () => {
    // The device has to arrive and be looked at before money moves.
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ status: "Paid" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(doc.status).toBe("Quoted");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("says where the request could go instead", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes({ status: "Paid" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(sent(res).allowed).toContain("LabelIssued");
  });

  it("never writes the status directly", async () => {
    // findByIdAndUpdate on status is the bypass this task exists to close.
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    const wroteStatus = TradeInRequest.findByIdAndUpdate.mock.calls
      .some(([, update]) => update && Object.prototype.hasOwnProperty.call(update, "status"));
    expect(wroteStatus).toBe(false);
  });

  it("refuses a status that is not one of ours", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes({ status: "Refunded" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("answers 404 for a request that is not there", async () => {
    TradeInRequest.findById.mockResolvedValue(null);

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(res.statusCode).toBe(404);
  });
});

describe("the timeline", () => {
  it("records who moved it and when", async () => {
    // "The customer says they posted it, we say it never arrived" is only
    // answerable from a log nobody can edit.
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(doc.timeline).toHaveLength(1);
    expect(doc.timeline[0]).toMatchObject({
      from: "Quoted",
      to: "LabelIssued",
      actor: "yasir@upcellit.com",
      actorType: "staff",
    });
  });

  it("keeps a note against the move when one is given", async () => {
    const doc = requestDoc();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(
      { status: "Rejected", note: "Screen is cracked through" },
      { params: { id: "tr1" } }
    );
    await controller.updateTradeInStatus(req, res, next);

    expect(doc.timeline[0].meta.note).toBe("Screen is cracked through");
  });

  it("only ever appends", async () => {
    const doc = requestDoc({ timeline: [{ event: "quote_sent", at: new Date() }] });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(doc.timeline).toHaveLength(2);
    expect(doc.timeline[0].event).toBe("quote_sent");
  });

  it("writes an audit row as well as a timeline entry", async () => {
    TradeInRequest.findById.mockResolvedValue(requestDoc());

    const { req, res, next } = makeReqRes({ status: "LabelIssued" }, { params: { id: "tr1" } });
    await controller.updateTradeInStatus(req, res, next);

    expect(AuditLog.create.mock.calls[0][0]).toMatchObject({
      action: "trade_in.status_update",
      metadata: { from: "Quoted", to: "LabelIssued" },
    });
  });
});

// Recording the payment and marking it paid are one action. Two endpoints
// would let a request sit at Paid with no record of how, which is the state
// somebody has to reconstruct from a bank statement months later when a
// customer says they were never paid.
describe("recording a payout", () => {
  const approved = (over = {}) => requestDoc({
    status: "Approved",
    estimateCents: 40000,
    ...over,
  });

  const payout = (over = {}) => ({
    method: "ZELLE",
    recipientName: "Sam Okonkwo",
    referenceMasked: "sam@example.com",
    ...over,
  });

  it("records the payment and marks it paid in one move", async () => {
    const doc = approved();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe("Paid");
    expect(doc.payout).toMatchObject({
      method: "ZELLE",
      recipientName: "Sam Okonkwo",
      amountCents: 40000,
      paidBy: "yasir@upcellit.com",
    });
  });

  it("will not pay a trade-in nobody has approved", async () => {
    // A request still in inspection has no agreed amount to pay.
    const doc = approved({ status: "InInspection" });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(doc.payout).toBeUndefined();
  });

  it("will not pay the same trade-in twice", async () => {
    const doc = approved({ status: "Paid", payout: { paidAt: new Date("2026-09-01") } });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("already paid");
  });

  it("masks the reference again on the way in", async () => {
    // Masking done in a browser is masking anybody can turn off, and this is
    // the copy that is kept.
    const doc = approved();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(
      payout({ method: "BANK_TRANSFER", referenceMasked: "123456789012" }),
      { params: { id: "tr1" } }
    );
    await controller.recordTradeInPayout(req, res, next);

    expect(doc.payout.referenceMasked).toBe("•••• 9012");
    expect(doc.payout.referenceMasked).not.toContain("12345678");
  });

  it("pays the revised offer when there was one", async () => {
    // A quote disputed in November is answered from what was agreed, not by
    // rerunning today's prices over it.
    const doc = approved({ revisedOfferCents: 31000 });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(doc.payout.amountCents).toBe(31000);
  });

  it("falls back to the dollar estimate on an older record", async () => {
    const doc = requestDoc({ status: "Approved", estimate: 400, estimateCents: undefined });
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(doc.payout.amountCents).toBe(40000);
  });

  it("writes the move to the timeline", async () => {
    const doc = approved();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(doc.timeline[0]).toMatchObject({
      event: "payout_recorded", from: "Approved", to: "Paid",
    });
  });

  it("audits the masked reference, never a full one", async () => {
    // An audit log is read by more people than the record it describes.
    const doc = approved();
    TradeInRequest.findById.mockResolvedValue(doc);

    const { req, res, next } = makeReqRes(
      payout({ method: "BANK_TRANSFER", referenceMasked: "123456789012" }),
      { params: { id: "tr1" } }
    );
    await controller.recordTradeInPayout(req, res, next);

    const [entry] = AuditLog.create.mock.calls[0];
    expect(entry.action).toBe("trade_in.payout_recorded");
    expect(JSON.stringify(entry)).not.toContain("123456789012");
  });

  it("answers 404 for a request that is not there", async () => {
    TradeInRequest.findById.mockResolvedValue(null);

    const { req, res, next } = makeReqRes(payout(), { params: { id: "tr1" } });
    await controller.recordTradeInPayout(req, res, next);

    expect(res.statusCode).toBe(404);
  });
});

// The submit path, and the hole this endpoint used to have.
//
// It stored whatever arrived, so posting `estimate: 9999` put nine thousand
// dollars in front of staff as an offer to honour, and nothing anywhere would
// have contradicted it.
//
// tests/tradeInPricing.test.js proves the pricing engine is pure and ignores an
// invented number. That is a different claim from this one: it does not prove
// the controller calls the engine rather than trusting the body. This is the
// test the plan's definition of done actually names.
describe("pricing a submitted trade-in on the server", () => {
  // iPhone 13, $590 base, 128GB at ×1.0, every answer best: $590.
  const priceBook = {
    modelKey: "iphone13",
    deviceType: "iPhone",
    displayName: "iPhone 13",
    basePriceCents: 59000,
    storageMultipliers: { "128GB": 1.0 },
    carrierAdjustments: { unlocked: 1.0 },
    active: true,
    priceBookVersion: 3,
  };

  const questions = [
    { id: "powersOn", question: "Does it power on?", type: "boolean", noMultiplier: 0.15, terminal: true },
    { id: "screenCracked", question: "Is the screen cracked?", type: "boolean", noMultiplier: 1.0 },
  ];

  const submission = (over = {}) => ({
    device: "phone",
    model: "iphone13",
    modelTitle: "iPhone 13",
    storage: "128GB",
    carrier: "unlocked",
    answers: { powersOn: true, screenCracked: false },
    name: "Sam Okonkwo",
    email: "sam@example.com",
    phone: "3132888312",
    ...over,
  });

  beforeEach(() => {
    TradeInPriceBook.findOne.mockReturnValue({ lean: () => Promise.resolve(priceBook) });
    TradeInQuestion.findOne.mockReturnValue({ lean: () => Promise.resolve({ deviceType: "iPhone", questions }) });
    TradeInRequest.create.mockImplementation((doc) => Promise.resolve({ ...doc, _id: "tr_new" }));
  });

  it("stores the server's number, not the one that was posted", async () => {
    const { req, res, next } = makeReqRes(submission({ estimate: 9999 }), { user: null });
    await controller.createTradeInRequest(req, res, next);

    expect(res.statusCode).toBe(201);
    const [stored] = TradeInRequest.create.mock.calls[0];
    expect(stored.estimateCents).toBe(59000);
    expect(stored.estimate).toBe(590);
  });

  it("keeps what the browser claimed, so a disagreement is visible", async () => {
    // Not used for the price. Kept because a stored value that never matches
    // means the page and the engine have drifted, and a wild one means
    // somebody edited the request before sending it.
    const { req, res, next } = makeReqRes(submission({ estimate: 9999 }), { user: null });
    await controller.createTradeInRequest(req, res, next);

    expect(TradeInRequest.create.mock.calls[0][0].clientEstimateCents).toBe(999900);
  });

  it("records the arithmetic, so a quote disputed in November can be explained", async () => {
    const { req, res, next } = makeReqRes(submission(), { user: null });
    await controller.createTradeInRequest(req, res, next);

    const [stored] = TradeInRequest.create.mock.calls[0];
    expect(Array.isArray(stored.quoteBreakdown)).toBe(true);
    expect(stored.quoteBreakdown.length).toBeGreaterThan(0);
    // The version that priced it, so it is checked against September's prices
    // rather than today's.
    expect(stored.priceBookVersion).toBe(3);
  });

  it("gives the quote fourteen days", async () => {
    const { req, res, next } = makeReqRes(submission(), { user: null });
    await controller.createTradeInRequest(req, res, next);

    const { quoteExpiresAt } = TradeInRequest.create.mock.calls[0][0];
    const days = (quoteExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(14);
  });

  it("prices a dead phone at 15% and stops there", async () => {
    // powersOn is terminal: nothing after it can raise the number back up.
    const { req, res, next } = makeReqRes(
      submission({ answers: { powersOn: false, screenCracked: false }, estimate: 590 }),
      { user: null }
    );
    await controller.createTradeInRequest(req, res, next);

    // $590 x 0.15 is $88.50, quoted as $89. The engine rounds to the whole
    // dollar once, on purpose: rounding to the cent here and letting the page
    // round again to the dollar rounds twice, which is what once made a $165.50
    // quote display as $165 and store as $166.
    expect(TradeInRequest.create.mock.calls[0][0].estimateCents).toBe(8900);
    expect(TradeInRequest.create.mock.calls[0][0].estimate).toBe(89);
  });

  it("refuses a model UpCell is not quoting for", async () => {
    TradeInPriceBook.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const { req, res, next } = makeReqRes(submission({ model: "nokia3310" }), { user: null });
    await controller.createTradeInRequest(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(TradeInRequest.create).not.toHaveBeenCalled();
  });

  it("only quotes an active model", async () => {
    // A model taken off the list keeps its row so an old quote can still be
    // explained, and must not be quoted again.
    const { req, res, next } = makeReqRes(submission(), { user: null });
    await controller.createTradeInRequest(req, res, next);

    expect(TradeInPriceBook.findOne.mock.calls[0][0].active).toBe(true);
  });

  it("starts the request at Quoted, through the schema default", async () => {
    const { req, res, next } = makeReqRes(submission(), { user: null });
    await controller.createTradeInRequest(req, res, next);

    // Not set by the controller — a trade-in starts at a price UpCell offered,
    // and the model's default says so. Asserted so a controller that begins
    // setting it by hand has to come past this test.
    expect(TradeInRequest.create.mock.calls[0][0].status).toBeUndefined();
  });
});
