const ParentProduct = require("../models/parentProduct.model");
const AvailableCatagories = require("../models/availableCategory.model");
const ShopCategory = require("../models/shopCategory.model");
const { SHOP_CATEGORY_DEFAULTS } = require("../constants/shopCategoryDefaults");

async function ensureShopCategories() {
  const existing = await ShopCategory.find().lean();
  const existingNames = new Set(existing.map((item) => item.modelName));
  const missing = SHOP_CATEGORY_DEFAULTS.filter((item) => !existingNames.has(item.modelName));

  if (missing.length) {
    await ShopCategory.insertMany(missing);
  }
}

async function getCategories(req, res, next) {
  try {
    const product = await ParentProduct.find();
    res.json(product);
  } catch (error) {
    next(error);
  }
}

async function getCategoryById(req, res, next) {
  try {
    const product = await ParentProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product family not found" });
    res.json(product);
  } catch (error) {
    next(error);
  }
}

async function getShopCategories(req, res, next) {
  try {
    await ensureShopCategories();
    const categories = await ShopCategory.find().sort({ modelName: 1 });
    res.json(categories);
  } catch (error) {
    next(error);
  }
}

async function getAvailableCategories(req, res, next) {
  try {
    const availableCatagories = await AvailableCatagories.find();
    res.status(200).json(availableCatagories);
  } catch (error) {
    next(error);
  }
}

async function makeAvailableCategories(req, res, next) {
  try {
    const ctg = new AvailableCatagories({ categories: [] });
    await ctg.save();
    res.status(200).json(ctg);
  } catch (error) {
    next(error);
  }
}

async function createCategory(req, res, next) {
  const { modelName, description, images } = req.body;

  try {
    const newProduct = new ParentProduct({ modelName, description, images });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (error) {
    next(error);
  }
}

async function createShopCategory(req, res, next) {
  const { modelName, description, images } = req.body;

  try {
    const created = await ShopCategory.findOneAndUpdate(
      { modelName },
      { modelName, description, images },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
}

function updateCategory(req, res, next) {
  const id = req.params.id;
  const update = req.body;

  ParentProduct.findByIdAndUpdate(id, update)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

function updateShopCategory(req, res, next) {
  const id = req.params.id;
  const update = req.body;

  ShopCategory.findByIdAndUpdate(id, update, { new: true })
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

function deleteCategory(req, res, next) {
  const id = req.params.id;
  ParentProduct.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

function deleteShopCategory(req, res, next) {
  const id = req.params.id;
  ShopCategory.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

module.exports = {
  getCategories,
  getCategoryById,
  getShopCategories,
  getAvailableCategories,
  makeAvailableCategories,
  createCategory,
  createShopCategory,
  updateCategory,
  updateShopCategory,
  deleteCategory,
  deleteShopCategory,
};
