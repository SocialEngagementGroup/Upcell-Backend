// What the trade-in page is allowed to know, and what a quote actually is.
//
// Both used to live in the browser. The page carried the whole price book in
// its bundle and did the arithmetic itself, which made the prices a deploy to
// change and the quote a number anybody could edit before posting it.

const TradeInPriceBook = require("../models/tradeInPriceBook.model");
const TradeInQuestion = require("../models/tradeInQuestion.model");
const { quote, teaser, toDollars } = require("../services/tradeInPricing");
const AuditLog = require("../models/auditLog.model");

/**
 * Every model UpCell is quoting for, and the questions each type is asked.
 *
 * Public and cached: it is the same answer for everyone and it changes when
 * staff edit a price, not when a customer does anything.
 *
 * The multipliers are deliberately not sent. The page needs to know what to
 * ask and what a device is worth at best; it does not need to know that a
 * cracked screen costs half, and shipping that invites a browser to do the
 * arithmetic again — which is the thing this change exists to stop.
 */
async function getTradeInCatalog(req, res, next) {
  try {
    const [books, questionSets] = await Promise.all([
      TradeInPriceBook.find({ active: true }).lean(),
      TradeInQuestion.find({}).lean(),
    ]);

    const questionsByType = new Map(questionSets.map((set) => [set.deviceType, set.questions || []]));

    const models = books.map((book) => ({
      modelKey: book.modelKey,
      deviceType: book.deviceType,
      brand: book.brand,
      displayName: book.displayName,
      storages: Object.keys(book.storageMultipliers || {}),
      carriers: Object.keys(book.carrierAdjustments || {}),
      // "Up to $X" — the best storage with the best answers, which is what
      // "up to" has to mean or the page quotes a number no device reaches.
      teaserDollars: toDollars(teaser({ priceBook: book, questions: questionsByType.get(book.deviceType) || [] })),
    }));

    const questions = questionSets.map((set) => ({
      deviceType: set.deviceType,
      questions: (set.questions || []).map((question) => ({
        id: question.id,
        question: question.question,
        subtitle: question.subtitle,
        type: question.type,
        // Titles and descriptions only. No multipliers.
        options: (question.options || []).map((option) => ({
          id: option.id,
          title: option.title,
          desc: option.desc,
        })),
      })),
    }));

    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).json({ models, questions });
  } catch (error) {
    return next(error);
  }
}

/**
 * What this exact device is worth, computed here.
 *
 * The page calls this as the customer answers, and gets back the same object
 * the submit will store — so the number on screen and the number in the
 * database are the same number, produced once, by this code.
 */
async function getTradeInQuote(req, res, next) {
  try {
    const { modelKey, storage, carrier, answers } = req.body || {};

    const priceBook = await TradeInPriceBook.findOne({ modelKey, active: true }).lean();
    if (!priceBook) {
      return res.status(404).json({ error: "We are not quoting for that model at the moment." });
    }

    const set = await TradeInQuestion.findOne({ deviceType: priceBook.deviceType }).lean();

    const result = quote({
      priceBook,
      questions: set?.questions || [],
      storage,
      carrier,
      answers: answers || {},
    });

    if (!result.ok) return res.status(400).json({ error: result.error });

    return res.status(200).json({
      modelKey,
      displayName: priceBook.displayName,
      estimate: toDollars(result.estimateCents),
      estimateCents: result.estimateCents,
      teaser: toDollars(teaser({ priceBook, questions: set?.questions || [] })),
      breakdown: result.breakdown,
      terminatedAt: result.terminatedAt,
      priceBookVersion: result.priceBookVersion,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The whole book, including models nobody is quoting for.
 *
 * The public catalogue hides inactive rows and the multipliers. This one shows
 * everything, because the person editing a price needs to see what it is being
 * multiplied by.
 */
async function getAdminPriceBook(req, res, next) {
  try {
    const [books, questionSets] = await Promise.all([
      TradeInPriceBook.find({}).sort({ deviceType: 1, basePriceCents: -1 }).lean(),
      TradeInQuestion.find({}).lean(),
    ]);

    return res.status(200).json({ models: books, questions: questionSets });
  } catch (error) {
    return next(error);
  }
}

/**
 * Edits one model's price.
 *
 * One model per call, not the whole book in one PUT. A bulk write lets a stale
 * tab overwrite somebody else's edit with no way to tell afterwards, and it
 * makes the audit row say "the book changed" when the question anybody asks is
 * which price, from what, to what, by whom.
 *
 * priceBookVersion goes up on every write. A request stores the version that
 * priced it, so a quote disputed in November is checked against the number
 * that was live in September rather than today's.
 */
async function updatePriceBookEntry(req, res, next) {
  try {
    const { basePrice, active, storageMultipliers, carrierAdjustments, displayName } = req.body || {};

    const book = await TradeInPriceBook.findOne({ modelKey: req.params.modelKey });
    if (!book) return res.status(404).json({ error: "That model is not in the price book." });

    const before = {
      basePriceCents: book.basePriceCents,
      active: book.active,
      displayName: book.displayName,
    };

    if (basePrice !== undefined) book.basePriceCents = Math.round(Number(basePrice) * 100);
    if (active !== undefined) book.active = Boolean(active);
    if (displayName !== undefined) book.displayName = String(displayName).trim();
    if (storageMultipliers !== undefined) book.storageMultipliers = storageMultipliers;
    if (carrierAdjustments !== undefined) book.carrierAdjustments = carrierAdjustments;

    book.priceBookVersion = (book.priceBookVersion || 1) + 1;
    book.updatedBy = req.user?.email || req.user?.id;

    await book.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "tradein.price_updated",
      targetType: "TradeInPriceBook",
      targetId: book._id,
      metadata: {
        modelKey: book.modelKey,
        // Both sides, in dollars, because "changed the price" without the two
        // numbers is not an answer to anything.
        from: before.basePriceCents / 100,
        to: book.basePriceCents / 100,
        activeFrom: before.active,
        activeTo: book.active,
        version: book.priceBookVersion,
      },
    }).catch((error) => {
      console.error("[audit] tradein.price_updated log failed:", error?.message || error);
    });

    return res.status(200).json({ ok: true, model: book });
  } catch (error) {
    return next(error);
  }
}

/**
 * Replaces one device type's question set.
 *
 * A whole set at a time, unlike the prices — the questions are an ordered list
 * where the order and the multipliers only make sense together, and editing
 * one row of it in isolation is how a set ends up with two "flawless" options
 * or none.
 */
async function updateQuestionSet(req, res, next) {
  try {
    const { questions } = req.body || {};

    const set = await TradeInQuestion.findOne({ deviceType: req.params.deviceType });
    if (!set) return res.status(404).json({ error: "No question set for that device type." });

    const before = (set.questions || []).length;

    set.questions = questions;
    set.priceBookVersion = (set.priceBookVersion || 1) + 1;
    set.updatedBy = req.user?.email || req.user?.id;

    await set.save();

    AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action: "tradein.questions_updated",
      targetType: "TradeInQuestion",
      targetId: set._id,
      metadata: { deviceType: set.deviceType, from: before, to: set.questions.length },
    }).catch((error) => {
      console.error("[audit] tradein.questions_updated log failed:", error?.message || error);
    });

    return res.status(200).json({ ok: true, questions: set.questions });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getTradeInCatalog,
  getTradeInQuote,
  getAdminPriceBook,
  updatePriceBookEntry,
  updateQuestionSet,
};

