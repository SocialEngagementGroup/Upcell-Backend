const mongoose = require("mongoose");
const ParentProduct = require("../models/parentProduct.model");
const SingleVariation = require("../models/singleVariation.model");
const { parentSlug, variantSlug, ensureUniqueSlug } = require("../utils/slug");
const Order = require("../models/order.model");

// The shop sells devices. Accessories are real products so the cart and
// checkout work on them, but they are offered on a device's own page and
// must never appear in a listing, a search, a filter, or as a variant of a
// phone. Lookups by id deliberately do not use this.
const BROWSABLE = { isAccessory: { $ne: true } };

const productCardFields = "slug imagePublicId imageIsGeneric parentCatagory productName categoryName description storage color price image outOfStock";

// The fields the admin product-management pages (AllProduct, AddProduct)
// actually render or edit — confirmed by grepping SingleProductGroup.jsx and
// ProductBatchForm.jsx field-by-field, not assumed. Deliberately includes
// discountPrice/originalPrice, which the customer-facing productCardFields
// above does not, and deliberately has no BROWSABLE filter — staff manage
// accessory pricing/stock here too, unlike the public shop listing.
const adminProductFields =
  "parentCatagory productName categoryName storage color price discountPrice originalPrice outOfStock image imagePublicId imageIsGeneric";

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

async function getProducts(req, res, next) {
  try {
    const allProduct = await SingleVariation.find().lean();
    res.json(allProduct);
  } catch (error) {
    next(error);
  }
}

// AllProduct and AddProduct both need the entire catalog in memory for
// instant client-side search and duplicate-name detection while typing — the
// same reasoning that kept the shop page's own filtering client-side (see
// getShopProducts). This is that same fix applied here: same ungrouped,
// unfiltered variation list, only the fields these two admin pages actually
// use. No BROWSABLE filter — unlike the public shop, admin tooling must
// still manage accessory pricing and stock.
async function getAdminProducts(req, res, next) {
  try {
    const products = await SingleVariation.find({}, adminProductFields).lean();
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
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

// Fields the product page actually renders: the pickers, the price, the photo,
// and the slug its variant links are built from. This returned every field of
// every variant before, including ones only the admin edit form uses.
const productDetailFields =
  "slug imagePublicId imageIsGeneric parentCatagory productName categoryName description storage color price discountPrice originalPrice condition image outOfStock";

async function getProductsByParent(req, res, next) {
  try {
    const id = req.params.parentId;
    const product = await SingleVariation.find(
      { parentCatagory: id, ...BROWSABLE },
      productDetailFields
    ).lean();

    // A family's variants change only when staff edit the catalogue, so the same
    // 60 seconds the shop listing uses applies here — and this is the request a
    // customer waits on when they open a product.
    // The price next to Add to cart. no-cache does not mean "do not cache" —
    // it means "always ask first". Express sends an ETag, so an unchanged
    // product answers 304 with no body, which is nearly as cheap as a hit
    // and is never wrong. max-age=60 meant an admin could correct a price
    // and a customer would still be shown, and offered, the old one.
    res.set("Cache-Control", "no-cache");
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
}

/**
 * Everything a product page needs, from one readable slug.
 *
 * The URL is /product/iphone-air-256gb-space-black — one segment, not
 * family-plus-variant. Variant slugs are globally unique (see the unique index
 * on the model), so the family is derivable from the product and does not need
 * to be in the path. Putting it there would have meant carrying the parent's
 * slug on every shop card, which is either a join on the busiest endpoint in
 * the app or the same string copied onto 956 documents and left to drift.
 *
 * Returns the selected variant and its whole family together, because the page
 * needs both immediately: the variant for the price and photo, the family for
 * the colour and storage pickers. Two requests would mean two waits.
 *
 * 404s on an unknown slug rather than returning an empty list — "no such
 * product" and "this product has no variants in stock" are different answers
 * and the page shows different things for each.
 */
async function getProductBySlug(req, res, next) {
  try {
    const product = await SingleVariation.findOne(
      { slug: req.params.slug, ...BROWSABLE },
      productDetailFields
    ).lean();

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const [family, parent] = await Promise.all([
      SingleVariation.find(
        { parentCatagory: product.parentCatagory, ...BROWSABLE },
        productDetailFields
      ).lean(),
      ParentProduct.findById(product.parentCatagory).select("modelName slug description images").lean(),
    ]);

    // The price next to Add to cart. no-cache does not mean "do not cache" —
    // it means "always ask first". Express sends an ETag, so an unchanged
    // product answers 304 with no body, which is nearly as cheap as a hit
    // and is never wrong. max-age=60 meant an admin could correct a price
    // and a customer would still be shown, and offered, the old one.
    res.set("Cache-Control", "no-cache");
    res.status(200).json({ product, family, parent });
  } catch (error) {
    next(error);
  }
}

// Deliberately returns individual variations, not grouped cards — grouping,
// filtering and search are the shop page's own job, done client-side against
// this same data, so results stay instant with no network round trip per
// click. This endpoint's only job is to hand that page a small enough
// payload to start with: only the fields a listing card needs, browsable
// products only, no accessories. See Frontend/src/pages/Shop/ShopPage.jsx.
async function getShopProducts(req, res, next) {
  try {
    const products = await SingleVariation.find(BROWSABLE, productCardFields)
      .sort({ outOfStock: 1, price: 1 })
      .lean();

    // A public catalogue listing, identical for every visitor, so it can sit in
    // the browser's own cache. Express already sends an ETag on this response;
    // what was missing is a Cache-Control that makes the browser willing to
    // revalidate against it, which turns a repeat visit into a 304 with no body
    // instead of a fresh download of the whole list.
    //
    // 60 seconds matches the frontend's React Query staleTime, so the two
    // layers expire together rather than one serving data the other considers
    // stale. stale-while-revalidate lets a return visit paint instantly from
    // cache while the refresh happens behind it — a price or stock edit is
    // visible within about a minute, which is the same delay the app already
    // accepts today.
    // A listing can lag briefly — nobody buys from it directly — but 60s of
    // hard caching plus 300s of stale-while-revalidate meant an edit took
    // minutes to surface, and showed the old data once even after a reload.
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
}

async function getRecommendedProducts(req, res, next) {
  try {
    const { excludeParentId, limit = 4 } = req.query;
    const maxResults = Math.min(Number(limit) || 4, 12);

    // Mongoose casts a string to an ObjectId for find(), but not inside an
    // aggregation — there is no schema in play there. Left as a string, the
    // $ne would match nothing, and a product page would recommend its own
    // family back to itself.
    const excludeId = mongoose.isValidObjectId(excludeParentId)
      ? new mongoose.Types.ObjectId(excludeParentId)
      : null;

    const match = excludeId
      ? { parentCatagory: { $ne: excludeId }, ...BROWSABLE }
      : { ...BROWSABLE };

    // Grouped in the database rather than in Node. This used to read every
    // browsable variation — 937 documents — build the cards here and throw all
    // but four away. Doing it this way returns only the cards that get
    // rendered: 614ms down to 289ms against the real catalogue.
    //
    // The colour and storage lists are collected in the same pass, because
    // they are what the card actually draws. Taking $first alone would be
    // faster still and would quietly drop every swatch.
    const cards = await SingleVariation.aggregate([
      { $match: match },
      // In-stock first, then cheapest — so $first below picks the variant a
      // customer would actually be offered, and the "From $x" price is the
      // lowest real one.
      { $sort: { outOfStock: 1, price: 1 } },
      {
        $group: {
          _id: "$parentCatagory",
          doc: { $first: "$$ROOT" },
          availableColors: {
            $addToSet: {
              $cond: [
                { $ifNull: ["$color.name", false] },
                {
                  name: "$color.name",
                  // Same fallback chain the grouping in Node used: value, then
                  // hex, then a neutral grey, so a swatch never renders blank.
                  value: { $ifNull: ["$color.value", { $ifNull: ["$color.hex", "#d1d5db"] }] },
                },
                "$$REMOVE",
              ],
            },
          },
          availableStorages: { $addToSet: { $ifNull: ["$storage", "$$REMOVE"] } },
        },
      },
      { $limit: maxResults },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              "$doc",
              { availableColors: "$availableColors", availableStorages: "$availableStorages" },
            ],
          },
        },
      },
      {
        $project: {
          slug: 1,
          parentCatagory: 1,
          productName: 1,
          categoryName: 1,
          storage: 1,
          color: 1,
          price: 1,
          image: 1,
          outOfStock: 1,
          availableColors: 1,
          availableStorages: 1,
        },
      },
    ]);

    // Identical for every visitor looking at the same product, and it changes
    // only when the catalogue does.
    // A listing can lag briefly — nobody buys from it directly — but 60s of
    // hard caching plus 300s of stale-while-revalidate meant an edit took
    // minutes to surface, and showed the old data once even after a reload.
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(cards);
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
      { $or: [{ productName: regex }, { categoryName: regex }], ...BROWSABLE },
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
    // Route params, not schema-validated — clamp here so a crafted URL
    // (e.g. /products/999999999/0) can't force an unbounded collection scan.
    const n = Math.min(Math.max(Number.parseInt(req.params.n, 10) || 20, 1), 100);
    const skip = Math.max(Number.parseInt(req.params.skip, 10) || 0, 0);

    const { productName, storage, color, price, condition } = req.body;

    const searchQuery = {
      productName: productName.length
        ? { $in: productName }
        : { $exists: true },
      storage: storage.length ? { $in: storage } : { $exists: true },
      "color.name": color.length ? { $in: color } : { $exists: true },
      condition: condition.length ? { $in: condition } : { $exists: true },
      price: { $gte: price[0], $lte: price[1] },
      ...BROWSABLE,
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

// What identifies a variant to a customer: the storage and colour they pick.
// Case and spacing are normalised so "128GB"/"128gb" and "Blue"/" blue " are
// the same variant rather than two.
const variantKey = (variant) =>
  `${String(variant.storage || "").trim().toLowerCase()}|${String(variant.color?.name || "").trim().toLowerCase()}`;

// Writes a product's variants, keeping the documents that already exist.
//
// Saving an edit used to delete every variant of the family and insert them
// again, which gave each one a new _id every time. Orders store the _id of what
// was bought, so every edit orphaned the orders placed before it: 5 of 32 live
// order lines were already pointing at documents that no longer existed, one of
// them on a shipped order.
//
// Nothing a customer sees breaks when that happens — an order stores its own
// snapshot of the name, image and price paid — but the restock does. Returning
// or refunding an order maps its line ids back to variations to put the stock
// back (services/inventory.js), and an id that matches nothing puts nothing
// back, silently.
//
// So variants are now matched on storage+colour: the same variant keeps its
// document, its _id and its slug, whatever else the admin changed. Only a
// genuinely new combination is inserted, and only a removed one is deleted.
async function saveVariants(parentId, variantDocs) {
  const existing = await SingleVariation.find({ parentCatagory: parentId }).lean();
  const existingByKey = new Map(existing.map((doc) => [variantKey(doc), doc]));

  const saved = [];
  const keptIds = new Set();

  for (const doc of variantDocs) {
    const match = existingByKey.get(variantKey(doc));

    if (!match) {
      saved.push(doc);
      continue;
    }

    keptIds.add(String(match._id));
    // The slug is the variant's public address, so it survives a rename for
    // the same reason the parent's does: a slug that changes is a URL that
    // breaks, and anything already linking to it stops working.
    const { slug, ...changes } = doc;

    // An emptied IMEI box means the admin took the number off this unit, and
    // $set ignores undefined — without this the old number would stay on the
    // record while the form showed it gone, and the unique index would keep
    // holding it against the device it was moved to.
    const unset = {};
    for (const key of ["imei", "serialNumber"]) {
      if (changes[key] === undefined) {
        unset[key] = "";
        delete changes[key];
      }
    }

    await SingleVariation.updateOne(
      { _id: match._id },
      Object.keys(unset).length ? { $set: changes, $unset: unset } : { $set: changes }
    );
    saved.push({ ...match, ...changes });
  }

  const toInsert = saved.filter((doc) => !doc._id);
  if (toInsert.length) {
    const inserted = await SingleVariation.insertMany(toInsert);
    inserted.forEach((doc, index) => { toInsert[index]._id = doc._id; });
  }

  // Combinations the admin removed from the form.
  const removed = existing
    .filter((doc) => !keptIds.has(String(doc._id)))
    .map((doc) => doc._id);
  if (removed.length) {
    await SingleVariation.deleteMany({ _id: { $in: removed } });
  }

  return saved;
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

      // An image reference is { url, publicId }. The publicId is the half that
      // matters: it is what a delivery URL is built from, so storing it is what
      // lets the same photo be served at a card's width and a detail view's
      // width. The admin panel uploads to Cloudinary and sends both.
      const parentImages = Array.isArray(images) && images.length
        ? images
        : (image ? [{ url: image }] : []);
      const primaryImage = parentImages[0]?.url || image;
      const primaryImagePublicId = parentImages[0]?.publicId;
      let parent = null;
      let wasExistingParent = false;

      if (existingParentId) {
        parent = await ParentProduct.findById(existingParentId);
      }
      if (!parent) {
        // Case/whitespace-insensitive fallback match, so re-saving a product
        // whose name only differs by case or stray spaces updates the
        // existing parent instead of silently creating a duplicate.
        const escapedName = productName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        parent = await ParentProduct.findOne({
          modelName: new RegExp(`^${escapedName}$`, "i"),
        });
      }

      if (parent) {
        wasExistingParent = true;
        parent.modelName = productName;
        parent.categoryName = categoryName;
        parent.categoryId = categoryId || undefined;
        parent.images = parentImages;
        // Only when it has none. A slug that changes is a URL that breaks, so a
        // rename keeps the address the product was first published at.
        if (!parent.slug) {
          parent.slug = await ensureUniqueSlug(parentSlug(productName), async (candidate) =>
            Boolean(await ParentProduct.exists({ slug: candidate, _id: { $ne: parent._id } }))
          );
        }
        await parent.save();
      } else {
        parent = await ParentProduct.create({
          modelName: productName,
          categoryName,
          categoryId: categoryId || undefined,
          images: parentImages,
          slug: await ensureUniqueSlug(parentSlug(productName), async (candidate) =>
            Boolean(await ParentProduct.exists({ slug: candidate }))
          ),
        });
      }

      // Every variant needs its own slug — it is the whole address of its page.
      // Without this a product saved through the admin form had none, so its
      // card had nothing to link to and search could not open it.
      //
      // Built in sequence rather than with Promise.all: two variants of the
      // same product can produce the same base slug, and each needs to see the
      // one before it to pick the next free suffix.
      // The photo an admin picked for this variant, looked up in the product's
      // own images so a variant can only ever point at one of them. Falls back
      // to the primary photo, which is what every variant used to get.
      const imageForVariant = (variant) => {
        const chosen = variant.imagePublicId
          ? parentImages.find((ref) => ref?.publicId === variant.imagePublicId)
          : null;
        return {
          variantImage: chosen?.url || primaryImage,
          variantImagePublicId: chosen?.publicId || primaryImagePublicId,
        };
      };

      const variantDocs = [];
      for (const variant of variants) {
        const { variantImage, variantImagePublicId } = imageForVariant(variant);
        const base = variantSlug({ productName, storage: variant.storage, color: variant.color });
        const slug = await ensureUniqueSlug(base, async (candidate) =>
          variantDocs.some((doc) => doc.slug === candidate) ||
          Boolean(await SingleVariation.exists({ slug: candidate }))
        );

        variantDocs.push({
          parentCatagory: parent._id,
          slug,
          productName,
          categoryName,
          categoryId: categoryId || undefined,
          storage: variant.storage,
          color: variant.color,
          // Which physical device this row is. Always written, even when empty,
          // so saveVariants can tell "cleared by the admin" from "not sent".
          imei: variant.imei,
          serialNumber: variant.serialNumber,
          price: variant.price,
          discountPrice: variant.discountPrice,
          originalPrice: variant.originalPrice,
          reviewScore,
          peopleReviewed,
          condition,
          image: variantImage,
          imagePublicId: variantImagePublicId,
          // A photo someone chose for this product, not a stand-in — so it is
          // shown as it is, and never replaced by a guess from the local image
          // manifest. That substitution is why an admin could upload one photo
          // and see a different one on the site.
          imageIsGeneric: false,
          // Written explicitly rather than left to the schema default, so the
          // field exists on the document and a query can use an index on it.
          isAccessory: false,
          outOfStock: Boolean(variant.outOfStock),
        });
      }

      const createdVariants = await saveVariants(parent._id, variantDocs);

      return res.status(wasExistingParent ? 200 : 201).json({
        parent,
        variants: createdVariants,
      });
    }

    const product = req.body;
    const newProduct = new SingleVariation(product);
    await newProduct.save();

    res.status(200).json(newProduct);
  } catch (error) {
    // The unique index on imei/serialNumber rejected a device that is already
    // in the catalogue under another product. The raw driver error names the
    // index and the value but reads as a crash; an admin needs to know which
    // number to go and look for.
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      if (field === "imei" || field === "serialNumber") {
        const label = field === "imei" ? "IMEI" : "serial number";
        const value = error.keyValue?.[field];
        return res.status(409).json({
          error: `The ${label} ${value} is already on another unit in the catalogue. One device can only be listed once — find that unit and remove it, or check the number.`,
        });
      }
    }

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

// Orders that bought any of these variants.
//
// Checked in both shapes an order can carry its lines in: `items` is the
// current one, `line_items` the legacy Stripe-shaped one still present on
// older orders (see the Chunk 7 note on the Order schema). Missing either
// would let a product be deleted out from under half the order history.
async function ordersReferencing(variationIds) {
  const ids = variationIds.map((id) => String(id));

  return Order.find({
    $or: [
      { "items.productId": { $in: variationIds } },
      { "line_items.price_data.product_data.metadata.productId": { $in: ids } },
    ],
  })
    .select("_id status")
    .limit(20)
    .lean();
}

// Refusing to delete is not tidiness — an order stores the id of what was
// bought, and returning or refunding it maps that id back to the variation to
// put the stock back. Delete the product and the restock silently puts nothing
// back. Sold products are taken off sale with outOfStock, not removed.
function blockedByOrders(res, orders, what) {
  return res.status(409).json({
    error: "Product has been ordered",
    message:
      `This ${what} cannot be deleted because ${orders.length === 1 ? "an order references" : orders.length + " orders reference"} it. ` +
      "Mark it out of stock instead — that removes it from the shop and keeps the order history intact.",
    orderIds: orders.map((order) => String(order._id)),
  });
}

async function deleteProduct(req, res, next) {
  try {
    const id = req.params.id;

    const orders = await ordersReferencing([new mongoose.Types.ObjectId(id)]);
    if (orders.length) return blockedByOrders(res, orders, "variant");

    const result = await SingleVariation.findByIdAndDelete(id);
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteProductFamily(req, res, next) {
  try {
    const parentId = req.params.parentId;

    const variations = await SingleVariation.find({ parentCatagory: parentId }).select("_id").lean();
    const orders = await ordersReferencing(variations.map((doc) => doc._id));
    if (orders.length) return blockedByOrders(res, orders, "product");

    await SingleVariation.deleteMany({ parentCatagory: parentId });
    const deletedParent = await ParentProduct.findByIdAndDelete(parentId);
    return res.status(200).json(deletedParent);
  } catch (error) {
    return next(error);
  }
}

// The accessories offered alongside a device on its product page. Returned as
// real products with real ids, so adding one to the cart goes through exactly
// the same path as adding a phone — no special handling anywhere downstream.
async function getAccessories(req, res, next) {
  try {
    const accessories = await SingleVariation.find(
      { isAccessory: true, outOfStock: { $ne: true } },
      "slug productName description price image storage color condition"
    )
      .sort({ price: 1 })
      .lean();

    // The same two accessories on every product page in the catalogue. Without
    // this each page view refetched them.
    // A listing can lag briefly — nobody buys from it directly — but 60s of
    // hard caching plus 300s of stale-while-revalidate meant an edit took
    // minutes to surface, and showed the old data once even after a reload.
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(accessories);
  } catch (error) {
    next(error);
  }
}


module.exports = {
  getProducts,
  getAdminProducts,
  getProduct,
  getProductsByParent,
  getProductBySlug,
  getShopProducts,
  getRecommendedProducts,
  getProductSuggestions,
  getFilteredProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteProductFamily,
  getAccessories,
};

