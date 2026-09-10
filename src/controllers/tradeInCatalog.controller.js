// What the trade-in page is allowed to know, and what a quote actually is.
//
// Both used to live in the browser. The page carried the whole price book in
// its bundle and did the arithmetic itself, which made the prices a deploy to
// change and the quote a number anybody could edit before posting it.

const TradeInPriceBook = require("../models/tradeInPriceBook.model");
const TradeInQuestion = require("../models/tradeInQuestion.model");
const { quote, teaser, toDollars } = require("../services/tradeInPricing");

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

module.exports = { getTradeInCatalog, getTradeInQuote };
