const { SHOP_SIDEBAR_MODELS } = require("./shopModels");

const defaultDescriptions = {
  "iPhone": "Core iPhone models with balanced everyday performance.",
  "iPhone Plus": "Larger-screen iPhone options with strong battery life.",
  "iPhone Pro": "Pro-tier iPhone models built for camera and performance upgrades.",
  "iPhone Pro Max": "Largest iPhone Pro configurations with premium features.",
  "iPad": "Standard iPad models for browsing, study, and daily productivity.",
  "iPad mini": "Compact iPad mini models with strong portability.",
  "iPad Air": "Thin and capable iPad Air models for flexible work and creativity.",
  "iPad Pro": "High-performance iPad Pro models for advanced creative tasks.",
  "MacBook Air": "Lightweight MacBook Air models with quiet everyday power.",
  "MacBook Pro": "Professional MacBook Pro models for sustained demanding workflows.",
};

// Cloudinary public_ids, not paths.
//
// These used to be "/staticImages/category-iphone.png" and friends. Those
// files were moved to Cloudinary by scripts/migrate-images-to-cloudinary.js
// and the local copies deleted, so every category seeded from this list has
// been carrying a URL that 404s — visible as a broken image on the admin
// categories page. The ids match STATIC_IMAGES in the frontend, which is
// where the same three pictures are referenced from.
const familyImages = {
  iPhone: [{ publicId: "upcell/static/category-iphone--bd89b1fb" }],
  iPad: [{ publicId: "upcell/static/category-ipad--d0e0352a" }],
  MacBook: [{ publicId: "upcell/static/category-macbook--c365e244" }],
};

const getCategoryImages = (modelName) => {
  if (modelName.startsWith("iPhone")) return familyImages.iPhone;
  if (modelName.startsWith("iPad")) return familyImages.iPad;
  if (modelName.startsWith("MacBook")) return familyImages.MacBook;
  return [];
};

const SHOP_CATEGORY_DEFAULTS = SHOP_SIDEBAR_MODELS.map((modelName) => ({
  modelName,
  description: defaultDescriptions[modelName] || "",
  images: getCategoryImages(modelName),
}));

module.exports = {
  SHOP_CATEGORY_DEFAULTS,
};
