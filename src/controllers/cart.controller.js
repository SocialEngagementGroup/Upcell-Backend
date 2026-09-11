// A signed-in customer's cart, kept on the server.
//
// The browser has always held it in localStorage, which means a cart filled
// on a phone is invisible on a laptop and gone when somebody clears their
// site data. For a shop where every row is one physical device, that matters
// more than usual: the phone somebody put in their cart on Tuesday may be the
// only one, and losing the cart is how they find out it sold.

const mongoose = require("mongoose");
const Cart = require("../models/cart.model");
const SingleVariation = require("../models/singleVariation.model");

const VALID_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Drops ids that cannot be bought any more.
 *
 * A cart is a list of promises the shop has not made. A device can sell,
 * be delisted, or fail an inspection between one visit and the next, and
 * handing those back would show a customer a cart they cannot check out.
 *
 * Returned rather than saved, so a read never writes — a cart that silently
 * shrinks on GET is one a customer cannot argue with.
 */
async function stillBuyable(ids) {
  const unique = [...new Set(ids.filter((id) => VALID_ID.test(String(id))))];
  if (!unique.length) return [];

  const found = await SingleVariation.find({
    _id: { $in: unique },
    outOfStock: { $ne: true },
    refurbState: { $nin: ["NEEDS_BATTERY", "NEEDS_REPAIR"] },
  })
    .select("_id")
    .lean();

  const buyable = new Set(found.map((row) => String(row._id)));

  // Order is preserved and duplicates are kept: the frontend removes a line
  // by its position, so reordering the list would remove the wrong one.
  return ids.filter((id) => buyable.has(String(id)));
}

async function getMyCart(req, res, next) {
  try {
    const cart = await Cart.findOne({ userId: req.user.id }).lean();
    const items = (cart?.items || []).map(String);

    const available = await stillBuyable(items);

    return res.status(200).json({
      items: available,
      // Said plainly so the page can tell the customer something went, rather
      // than leaving them to notice a shorter list.
      removed: items.length - available.length,
    });
  } catch (error) {
    return next(error);
  }
}

async function putMyCart(req, res, next) {
  try {
    const submitted = Array.isArray(req.body?.items) ? req.body.items : [];

    // Capped. A cart is a shopping list, and an unbounded array from a client
    // is a document somebody can grow until it stops loading.
    const ids = submitted
      .filter((id) => VALID_ID.test(String(id)))
      .slice(0, 50)
      .map((id) => new mongoose.Types.ObjectId(String(id)));

    await Cart.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { items: ids } },
      { upsert: true, new: true }
    );

    return res.status(200).json({ ok: true, items: ids.map(String) });
  } catch (error) {
    return next(error);
  }
}

// The browser cart is a list of ids; this turns it back into products to
// render. Unauthenticated on purpose — it answers with catalogue rows that
// the shop page already shows to everybody.
async function getCartProducts(req, res, next) {
  try {
    const { ids } = req.body;
    const products = await SingleVariation.find({ _id: { $in: ids || [] } });
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

module.exports = { getCartProducts, getMyCart, putMyCart, stillBuyable };
