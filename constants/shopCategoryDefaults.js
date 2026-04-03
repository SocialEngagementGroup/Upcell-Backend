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

const familyImages = {
  iPhone: [{ url: "/staticImages/category-iphone.png" }],
  iPad: [{ url: "/staticImages/category-ipad.png" }],
  MacBook: [{ url: "/staticImages/category-macbook.png" }],
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
