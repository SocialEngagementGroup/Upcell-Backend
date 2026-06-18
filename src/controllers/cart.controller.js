const SingleVariation = require("../models/singleVariation.model");

async function getCartProducts(req, res, next) {
  try {
    const { ids } = req.body;
    const products = await SingleVariation.find({ _id: { $in: ids || [] } });
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

module.exports = { getCartProducts };
