process.env.RESEND_KEY = "test-resend-key";
process.env.EMAIL_FROM = "noreply@example.com";

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ id: "email_1" }) },
  })),
}));
jest.mock("../src/models/tradeInPriceBook.model");
jest.mock("../src/models/tradeInQuestion.model");
jest.mock("../src/models/auditLog.model");

const TradeInPriceBook = require("../src/models/tradeInPriceBook.model");
const TradeInQuestion = require("../src/models/tradeInQuestion.model");
const AuditLog = require("../src/models/auditLog.model");
const controller = require("../src/controllers/tradeInCatalog.controller");

const makeReqRes = (body = {}, { params = {}, user } = {}) => {
  const req = { body, params, user };
  const res = {
    statusCode: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

const STAFF = { id: "user_admin", email: "yasir@upcellit.com", role: "admin" };

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.create.mockResolvedValue({});
});

// Until this existed the 49 seeded prices were live and unreachable: a
// developer for every change Yasir wanted to make.
describe("the price book, for the people who set the prices", () => {
  const entry = (overrides = {}) => ({
    _id: "book1",
    modelKey: "iphone15pro",
    displayName: "iPhone 15 Pro",
    deviceType: "iPhone",
    basePriceCents: 59000,
    active: true,
    priceBookVersion: 3,
    storageMultipliers: { "128GB": 1.0, "256GB": 1.12 },
    carrierAdjustments: { unlocked: 1.0 },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  const edit = async (book, body) => {
    TradeInPriceBook.findOne.mockResolvedValue(book);

    const { req, res, next } = makeReqRes(body, { params: { modelKey: "iphone15pro" }, user: STAFF });
    await controller.updatePriceBookEntry(req, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return res;
  };

  it("changes a price, in dollars in and cents out", () => {
    const book = entry();

    return edit(book, { basePrice: 625 }).then(() => {
      expect(book.basePriceCents).toBe(62500);
      expect(book.save).toHaveBeenCalled();
    });
  });

  it("bumps the version on every write", async () => {
    // A request stores the version that priced it, so a quote disputed in
    // November is checked against September's number rather than today's.
    const book = entry();

    await edit(book, { basePrice: 625 });

    expect(book.priceBookVersion).toBe(4);
  });

  it("records who changed which price, from what to what", async () => {
    // "The price book changed" is not an answer to anything.
    const book = entry();

    await edit(book, { basePrice: 625 });

    const [row] = AuditLog.create.mock.calls[0];
    expect(row).toMatchObject({
      action: "tradein.price_updated",
      actorEmail: "yasir@upcellit.com",
      targetType: "TradeInPriceBook",
      targetId: "book1",
    });
    expect(row.metadata).toMatchObject({ modelKey: "iphone15pro", from: 590, to: 625 });
  });

  it("leaves untouched fields alone", async () => {
    // The screen sends only what changed, so a form that never opened the
    // multipliers must not blank them by omission.
    const book = entry();

    await edit(book, { basePrice: 625 });

    expect(book.storageMultipliers).toEqual({ "128GB": 1.0, "256GB": 1.12 });
    expect(book.displayName).toBe("iPhone 15 Pro");
    expect(book.active).toBe(true);
  });

  it("takes a model off the list without deleting its row", async () => {
    // An old request still has to be explainable.
    const book = entry();

    await edit(book, { active: false });

    expect(book.active).toBe(false);
    expect(AuditLog.create.mock.calls[0][0].metadata).toMatchObject({ activeFrom: true, activeTo: false });
  });

  it("404s a model that is not in the book", async () => {
    TradeInPriceBook.findOne.mockResolvedValue(null);

    const { req, res, next } = makeReqRes({ basePrice: 1 }, { params: { modelKey: "nokia3310" }, user: STAFF });
    await controller.updatePriceBookEntry(req, res, next);

    expect(res.statusCode).toBe(404);
  });

  it("shows the whole book, inactive rows and multipliers included", async () => {
    // The public catalogue hides both. The person editing a price needs to see
    // what it is being multiplied by.
    TradeInPriceBook.find.mockReturnValue({ sort: () => ({ lean: async () => [entry(), entry({ active: false })] }) });
    TradeInQuestion.find.mockReturnValue({ lean: async () => [] });

    const { req, res, next } = makeReqRes({}, { user: STAFF });
    await controller.getAdminPriceBook(req, res, next);

    const body = sent(res);
    expect(body.models).toHaveLength(2);
    expect(body.models.some((model) => !model.active)).toBe(true);
    expect(body.models[0].storageMultipliers).toBeDefined();
  });
});

describe("the question set", () => {
  const set = () => ({
    _id: "set1",
    deviceType: "iPhone",
    questions: [{ id: "powersOn", type: "boolean" }],
    priceBookVersion: 2,
    save: jest.fn().mockResolvedValue(true),
  });

  it("is replaced whole, and the version goes up", async () => {
    // The questions are an ordered list whose order and multipliers only make
    // sense together — editing one row in isolation is how a set ends up with
    // two "flawless" options or none.
    const existing = set();
    TradeInQuestion.findOne.mockResolvedValue(existing);

    const questions = [
      { id: "powersOn", question: "Does it turn on?", type: "boolean", noMultiplier: 0.15, terminal: true },
      { id: "screenCondition", question: "Screen?", type: "choice", options: [{ id: "good", title: "Good", multiplier: 0.9 }] },
    ];

    const { req, res, next } = makeReqRes({ questions }, { params: { deviceType: "iPhone" }, user: STAFF });
    await controller.updateQuestionSet(req, res, next);

    expect(existing.questions).toHaveLength(2);
    expect(existing.priceBookVersion).toBe(3);
    expect(AuditLog.create.mock.calls[0][0].metadata).toMatchObject({ deviceType: "iPhone", from: 1, to: 2 });
  });

  it("404s a device type with no set", async () => {
    TradeInQuestion.findOne.mockResolvedValue(null);

    const { req, res, next } = makeReqRes({ questions: [] }, { params: { deviceType: "Nokia" }, user: STAFF });
    await controller.updateQuestionSet(req, res, next);

    expect(res.statusCode).toBe(404);
  });
});

describe("what the schemas refuse", () => {
  const { priceBookEntrySchema, questionSetSchema } = require("../src/schemas/request.schemas");

  it("refuses a negative price", () => {
    expect(priceBookEntrySchema.safeParse({ basePrice: -1 }).success).toBe(false);
  });

  it("refuses a multiplier that pays more for a worse device", () => {
    // Always a typo. 1.2 on a cracked screen would pay a premium for damage.
    expect(questionSetSchema.safeParse({
      questions: [{ id: "x", question: "?", type: "choice", options: [{ id: "a", title: "A", multiplier: 1.2 }] }],
    }).success).toBe(false);

    expect(questionSetSchema.safeParse({
      questions: [{ id: "x", question: "?", type: "boolean", noMultiplier: 1.5 }],
    }).success).toBe(false);
  });

  it("refuses a device type with no questions at all", () => {
    expect(questionSetSchema.safeParse({ questions: [] }).success).toBe(false);
  });

  it("accepts a partial price edit", () => {
    // Every field optional, so the screen can send only what changed.
    expect(priceBookEntrySchema.safeParse({ active: false }).success).toBe(true);
    expect(priceBookEntrySchema.safeParse({}).success).toBe(true);
  });
});
