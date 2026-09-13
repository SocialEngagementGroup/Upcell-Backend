// Asking a customer what they thought, a week after their phone arrived.
//
// This runs unattended on a daily pass, and a bug in it emails real people
// the wrong thing at three in the morning — so every dependency is faked and
// every rule about who gets asked is checked here rather than in production.

const { sendReviewPrompts, REVIEW_PROMPT_DAYS } = require("../src/services/returnJobs");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-11T09:00:00Z");

const order = (over = {}) => ({
  _id: "order1",
  email: "buyer@example.com",
  userId: "user_1",
  status: "Delivered",
  deliveredAt: new Date(NOW.getTime() - 8 * DAY),
  items: [{ productId: "p1", name: "iPhone 13" }],
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

// Records the query as well as answering it, so the filter can be asserted —
// which is the whole of who does and does not get an email.
const orderModel = (rows) => {
  const find = jest.fn().mockReturnValue({ limit: () => Promise.resolve(rows) });
  return { find };
};

const buildEmail = jest.fn((o, items) => ({ subject: `About your ${items[0]?.name}`, html: "<p>hi</p>" }));

let sendEmail;

beforeEach(() => {
  jest.clearAllMocks();
  sendEmail = jest.fn();
});

describe("who gets asked", () => {
  it("emails a customer a week after delivery", async () => {
    const Order = orderModel([order()]);

    const report = await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(report.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith("buyer@example.com", expect.objectContaining({ subject: expect.any(String) }));
  });

  it("waits the full week before asking", async () => {
    // Long enough that somebody has actually used the phone.
    const Order = orderModel([]);

    await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    const [query] = Order.find.mock.calls[0];
    const cutoff = query.deliveredAt.$lte;
    expect(NOW.getTime() - cutoff.getTime()).toBe(REVIEW_PROMPT_DAYS * DAY);
  });

  it("only asks about delivered orders", async () => {
    const Order = orderModel([]);
    await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(Order.find.mock.calls[0][0].status).toBe("Delivered");
  });

  it("never asks twice", async () => {
    const Order = orderModel([]);
    await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    // A second email asking for a review is where a shop stops sounding
    // interested and starts sounding like it wants something.
    expect(Order.find.mock.calls[0][0].reviewPromptSentAt).toEqual({ $exists: false });
  });

  it("skips guests, who cannot write one", async () => {
    // A review has to be tied to an account, so asking somebody who cannot
    // write one is a waste of their attention.
    const Order = orderModel([]);
    await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(Order.find.mock.calls[0][0].userId).toEqual({ $exists: true, $ne: null });
  });

  it("skips an order with nothing on it", async () => {
    const Order = orderModel([order({ items: [] })]);

    const report = await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(report.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a refunded order", async () => {
    // There is no device the customer kept to have an opinion about.
    const Order = orderModel([order({ status: "Refunded" })]);

    const report = await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(report.sent).toBe(0);
  });
});

describe("not asking the same person twice", () => {
  it("marks the order before sending, not after", async () => {
    // A duplicate email annoys somebody; a crash between sending and saving
    // would ask again on every run until the job stopped crashing.
    const doc = order();
    let markedBeforeSend = false;
    const Order = orderModel([doc]);
    sendEmail = jest.fn(() => { markedBeforeSend = Boolean(doc.reviewPromptSentAt); });

    await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(markedBeforeSend).toBe(true);
  });

  it("stamps the order with when it was asked", async () => {
    const doc = order();
    await sendReviewPrompts({ Order: orderModel([doc]), sendEmail, buildEmail, now: NOW });

    expect(doc.reviewPromptSentAt).toBe(NOW);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe("when something goes wrong", () => {
  it("carries on to the next order", async () => {
    // One unsaveable order must not stop the other 199 being asked.
    const broken = order({ _id: "bad", save: jest.fn().mockRejectedValue(new Error("mongo")) });
    const Order = orderModel([broken, order({ _id: "good" })]);

    const report = await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(report.sent).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].orderId).toBe("bad");
  });

  it("reports how many it looked at, not only how many it sent", async () => {
    const Order = orderModel([order(), order({ items: [] })]);

    const report = await sendReviewPrompts({ Order, sendEmail, buildEmail, now: NOW });

    expect(report).toMatchObject({ sent: 1, considered: 2 });
  });
});
