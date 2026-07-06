const ParentProduct = require("../models/parentProduct.model");
const SingleVariation = require("../models/singleVariation.model");
const AvailableCatagories = require("../models/availableCategory.model");

const productCardFields = "parentCatagory productName categoryName description storage color price image outOfStock";

const normalizeProductCard = (product) => ({
  ...product,
  _id: String(product._id),
  parentCatagory: String(product.parentCatagory),
  color: {
    ...(product.color || {}),
    value: product.color?.value || product.color?.hex || "#d1d5db",
  },
  availableColors: product.availableColors || [],
  availableStorages: product.availableStorages || [],
});

const groupProductCards = (products = []) => {
  const map = new Map();

  products.forEach((product) => {
    if (!product.parentCatagory) return;

    const key = String(product.parentCatagory);
    const existing = map.get(key);
    const nextColor = product.color?.name
      ? {
          name: product.color.name,
          value: product.color?.value || product.color?.hex || "#d1d5db",
        }
      : null;

    const mergeVariantMeta = (baseProduct) => {
      const colorMap = new Map(
        (baseProduct.availableColors || []).map((color) => [color.name, color])
      );
      const storageSet = new Set(baseProduct.availableStorages || []);

      if (nextColor) colorMap.set(nextColor.name, nextColor);
      if (product.storage) storageSet.add(product.storage);

      return {
        ...baseProduct,
        availableColors: Array.from(colorMap.values()),
        availableStorages: Array.from(storageSet.values()),
      };
    };

    if (product.outOfStock && !existing) {
      map.set(key, mergeVariantMeta(product));
      return;
    }
    if (existing?.outOfStock && !product.outOfStock) {
      map.set(key, mergeVariantMeta(product));
      return;
    }
    if ((!existing || Number(product.price || 0) < Number(existing.price || 0)) && !(product.outOfStock && !existing?.outOfStock)) {
      map.set(key, mergeVariantMeta(product));
      return;
    }

    if (existing) {
      map.set(key, mergeVariantMeta(existing));
    }
  });

  return Array.from(map.values()).map(normalizeProductCard);
};

async function getProducts(req, res) {
  const allProduct = await SingleVariation.find().lean();
  res.json(allProduct);
}

async function getProduct(req, res, next) {
  try {
    const id = req.params.id;
    const product = await SingleVariation.findById(id).lean();
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
}

async function getProductsByParent(req, res, next) {
  try {
    const id = req.params.parentId;
    const product = await SingleVariation.find({ parentCatagory: id }).lean();
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
}

async function getShopProducts(req, res, next) {
  try {
    const products = await SingleVariation.find({}, productCardFields)
      .sort({ outOfStock: 1, price: 1 })
      .lean();

    res.status(200).json(groupProductCards(products));
  } catch (error) {
    next(error);
  }
}

async function getRecommendedProducts(req, res, next) {
  try {
    const { excludeParentId, limit = 4 } = req.query;
    const query = excludeParentId ? { parentCatagory: { $ne: excludeParentId } } : {};
    const maxResults = Math.min(Number(limit) || 4, 12);

    const products = await SingleVariation.find(query, productCardFields)
      .sort({ outOfStock: 1, price: 1 })
      .lean();

    res.status(200).json(groupProductCards(products).slice(0, maxResults));
  } catch (error) {
    next(error);
  }
}

async function searchProducts(req, res, next) {
  const query = req.query.search;

  if (!query) return res.status(200).json([]);

  const searchTerms = query.split(" ");

  try {
    const filterredWord = searchTerms
      .filter((word) => !/^iphone$/i.test(word))
      .join(" ");

    const escaped = filterredWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const result = await SingleVariation.find({
      $or: [{ productName: { $regex: regex } }],
    }).lean();

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function getProductSuggestions(req, res, next) {
  try {
    const term = (req.query.q || req.query.search || "").trim();
    if (term.length < 2) return res.status(200).json([]);

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    // Light projection + sorted so the best representative (in-stock, cheapest) comes first.
    const matches = await SingleVariation.find(
      { $or: [{ productName: regex }, { categoryName: regex }] },
      "productName parentCatagory categoryName image price outOfStock"
    )
      .sort({ outOfStock: 1, price: 1 })
      .limit(300)
      .lean();

    // Collapse variations to one suggestion per product family (no hard cap;
    // the dropdown scrolls). Dedupe still keeps it to one row per product.
    const byParent = new Map();
    for (const variation of matches) {
      const key = String(variation.parentCatagory);
      if (!byParent.has(key)) byParent.set(key, variation);
    }

    const suggestions = Array.from(byParent.values())
      .map((variation) => ({
        _id: String(variation._id),
        parentCatagory: String(variation.parentCatagory),
        productName: variation.productName,
        categoryName: variation.categoryName,
        image: variation.image,
        price: variation.price,
      }));

    res.status(200).json(suggestions);
  } catch (error) {
    next(error);
  }
}

async function getFilteredProducts(req, res, next) {
  try {
    const n = req.params.n;
    const skip = req.params.skip;

    const { productName, storage, color, price, condition } = req.body;

    const searchQuery = {
      productName: productName.length
        ? { $in: productName }
        : { $exists: true },
      storage: storage.length ? { $in: storage } : { $exists: true },
      "color.name": color.length ? { $in: color } : { $exists: true },
      condition: condition.length ? { $in: condition } : { $exists: true },
      price: { $gte: price[0], $lte: price[1] },
    };

    const products = await SingleVariation.find(searchQuery)
      .skip(skip)
      .limit(n)
      .lean();

    res.json(products);
  } catch (error) {
    next(error);
  }
}

async function createProduct(req, res, next) {
  try {
    if (Array.isArray(req.body.variants)) {
      const {
        existingParentId,
        productName,
        categoryName,
        categoryId,
        image,
        images,
        reviewScore,
        peopleReviewed,
        condition,
        variants,
      } = req.body;

      const parentImages = Array.isArray(images) && images.length
        ? images
        : (image ? [{ url: image }] : []);
      const primaryImage = parentImages[0]?.url || image;
      let parent = null;
      let wasExistingParent = false;

      if (existingParentId) {
        parent = await ParentProduct.findById(existingParentId);
      }
      if (!parent) {
        parent = await ParentProduct.findOne({ modelName: productName });
      }

      if (parent) {
        wasExistingParent = true;
        parent.modelName = productName;
        parent.categoryName = categoryName;
        parent.categoryId = categoryId || undefined;
        parent.images = parentImages;
        await parent.save();
        await SingleVariation.deleteMany({ parentCatagory: parent._id });
      } else {
        parent = await ParentProduct.create({
          modelName: productName,
          categoryName,
          categoryId: categoryId || undefined,
          images: parentImages,
        });
      }

      const createdVariants = await SingleVariation.insertMany(
        variants.map((variant) => ({
          parentCatagory: parent._id,
          productName,
          categoryName,
          categoryId: categoryId || undefined,
          storage: variant.storage,
          color: variant.color,
          price: variant.price,
          discountPrice: variant.discountPrice,
          originalPrice: variant.originalPrice,
          reviewScore,
          peopleReviewed,
          condition,
          image: primaryImage,
          outOfStock: Boolean(variant.outOfStock),
        }))
      );

      const act = await AvailableCatagories.find();
      if (act[0]?._id) {
        await AvailableCatagories.findByIdAndUpdate(act[0]._id, {
          $addToSet: { categories: productName },
        });
      }

      return res.status(wasExistingParent ? 200 : 201).json({
        parent,
        variants: createdVariants,
      });
    }

    const product = req.body;
    const newProduct = new SingleVariation(product);
    await newProduct.save();

    const act = await AvailableCatagories.find();
    const idCtg = act[0]?._id;
    if (idCtg) {
      await AvailableCatagories.findByIdAndUpdate(idCtg, {
        $addToSet: { categories: newProduct.productName },
      });
    }

    res.status(200).json(newProduct);
  } catch (error) {
    next(error);
  }
}

function updateProduct(req, res, next) {
  const id = req.params.id;
  const update = req.body;

  SingleVariation.findByIdAndUpdate(id, update)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

function deleteProduct(req, res, next) {
  const id = req.params.id;

  SingleVariation.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
}

async function deleteProductFamily(req, res, next) {
  try {
    const parentId = req.params.parentId;
    await SingleVariation.deleteMany({ parentCatagory: parentId });
    const deletedParent = await ParentProduct.findByIdAndDelete(parentId);
    res.status(200).json(deletedParent);
  } catch (error) {
    next(error);
  }
}

async function getRepresentativeProducts(req, res, next) {
  try {
    const availCatagoriesData = await AvailableCatagories.find();
    if (!availCatagoriesData.length) return res.status(200).json([]);
    const { categories } = availCatagoriesData[0];

    const allMatches = await SingleVariation.find({ productName: { $in: categories } }).lean();

    const products = categories
      .map((name) => allMatches.find((p) => p.productName === name))
      .filter(Boolean);

    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProducts,
  getProduct,
  getProductsByParent,
  getShopProducts,
  getRecommendedProducts,
  searchProducts,
  getProductSuggestions,
  getFilteredProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteProductFamily,
  getRepresentativeProducts,
};

