const { connectToDb, disconnectDb } = require("./database");
const ParentProduct = require("./schema/parentProduct");
const SingleVariation = require("./schema/singleVariation");
const AvailableCatagories = require("./schema/availableCatagories");

const resetMode = process.argv.includes("--reset");

const familyImages = {
  iPhone: [
    { url: "/staticImages/hero-iphone15.png" },
    { url: "/staticImages/category-iphone.png" },
  ],
  iPad: [{ url: "/staticImages/category-ipad.png" }],
  MacBook: [{ url: "/staticImages/category-macbook.png" }],
};

const familyVariationImage = {
  iPhone: "/staticImages/hero-iphone15.png",
  iPad: "/staticImages/category-ipad.png",
  MacBook: "/staticImages/category-macbook.png",
};

const familyColors = {
  iPhone: [
    { name: "Black", value: "#2F3033" },
    { name: "Silver", value: "#D9DBDE" },
    { name: "Blue", value: "#7A90A8" },
    { name: "Natural", value: "#B7B1A8" },
  ],
  iPad: [
    { name: "Space Gray", value: "#6F747C" },
    { name: "Silver", value: "#E3E5E6" },
    { name: "Blue", value: "#9CB2C9" },
    { name: "Starlight", value: "#F0E8DA" },
  ],
  MacBook: [
    { name: "Space Black", value: "#2F3135" },
    { name: "Space Gray", value: "#62666C" },
    { name: "Silver", value: "#D8DADC" },
    { name: "Midnight", value: "#2C3440" },
  ],
};

const storageAdjustments = {
  "128GB": 0,
  "256GB": 100,
  "512GB": 240,
  "1TB": 420,
  "2TB": 680,
  "4TB": 980,
  "8TB": 1480,
};

const conditionCycle = ["Excellent", "Mint", "Good", "Excellent"];

const catalogDefinitions = [
  { modelName: "iPhone 16e", family: "iPhone", basePrice: 699, storages: ["128GB", "256GB", "512GB"], description: "Value-focused current-generation iPhone configurations with modern performance." },
  { modelName: "iPhone 16", family: "iPhone", basePrice: 799, storages: ["128GB", "256GB", "512GB"], description: "Current iPhone lineup with balanced performance, camera quality, and battery life." },
  { modelName: "iPhone 16 Plus", family: "iPhone", basePrice: 899, storages: ["128GB", "256GB", "512GB"], description: "Large-screen iPhone options with strong battery life and everyday versatility." },
  { modelName: "iPhone 16 Pro", family: "iPhone", basePrice: 999, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Professional-grade iPhone configurations with flagship camera and display features." },
  { modelName: "iPhone 16 Pro Max", family: "iPhone", basePrice: 1199, storages: ["256GB", "512GB", "1TB"], description: "Top-tier iPhone lineup with the largest display and premium feature set." },
  { modelName: "iPhone 15", family: "iPhone", basePrice: 699, storages: ["128GB", "256GB", "512GB"], description: "Refined iPhone configurations that still deliver strong everyday value." },
  { modelName: "iPhone 15 Plus", family: "iPhone", basePrice: 799, storages: ["128GB", "256GB", "512GB"], description: "Large-format iPhone options with dependable battery life and bright displays." },
  { modelName: "iPhone 15 Pro", family: "iPhone", basePrice: 949, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Premium titanium iPhone configurations built for power users and creators." },
  { modelName: "iPhone 15 Pro Max", family: "iPhone", basePrice: 1099, storages: ["256GB", "512GB", "1TB"], description: "Flagship titanium iPhone configurations with premium finish options." },
  { modelName: "iPhone 14", family: "iPhone", basePrice: 599, storages: ["128GB", "256GB", "512GB"], description: "Reliable iPhone models with proven camera performance and smooth daily use." },
  { modelName: "iPhone 14 Plus", family: "iPhone", basePrice: 699, storages: ["128GB", "256GB", "512GB"], description: "Spacious iPhone options with a larger screen and all-day battery life." },
  { modelName: "iPhone 14 Pro", family: "iPhone", basePrice: 849, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Refined iPhone Pro options with standout camera and display quality." },
  { modelName: "iPhone 14 Pro Max", family: "iPhone", basePrice: 949, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Large-screen iPhone Pro options with premium imaging and battery endurance." },
  { modelName: "iPhone 13", family: "iPhone", basePrice: 529, storages: ["128GB", "256GB", "512GB"], description: "Well-rounded iPhone models that remain a strong entry point into the lineup." },
  { modelName: "iPhone 13 mini", family: "iPhone", basePrice: 499, storages: ["128GB", "256GB", "512GB"], description: "Compact iPhone configurations for customers who prefer a smaller form factor." },
  { modelName: "iPhone 13 Pro", family: "iPhone", basePrice: 679, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Compact iPhone Pro options with triple-camera flexibility and strong performance." },
  { modelName: "iPhone 13 Pro Max", family: "iPhone", basePrice: 779, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Large iPhone Pro configurations with extended battery life and premium features." },
  { modelName: "iPad (A16)", family: "iPad", basePrice: 349, storages: ["128GB", "256GB", "512GB"], description: "Current standard iPad options for school, browsing, and everyday productivity." },
  { modelName: "iPad mini (A17 Pro)", family: "iPad", basePrice: 499, storages: ["128GB", "256GB", "512GB"], description: "Portable iPad mini configurations that balance power with a compact footprint." },
  { modelName: "iPad Air 11-inch (M3)", family: "iPad", basePrice: 599, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Lightweight iPad Air options with laptop-class performance for flexible work." },
  { modelName: "iPad Air 13-inch (M3)", family: "iPad", basePrice: 799, storages: ["128GB", "256GB", "512GB", "1TB"], description: "Large-screen iPad Air configurations ideal for study, drawing, and multitasking." },
  { modelName: "iPad Pro 11-inch (M5)", family: "iPad", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], description: "Compact iPad Pro configurations built for demanding creative and professional work." },
  { modelName: "iPad Pro 13-inch (M5)", family: "iPad", basePrice: 1299, storages: ["256GB", "512GB", "1TB", "2TB"], description: "Large-format iPad Pro lineup designed for creators, editors, and multitaskers." },
  { modelName: "MacBook Air 13-inch (M5)", family: "MacBook", basePrice: 1199, storages: ["256GB", "512GB", "1TB", "2TB"], description: "Thin-and-light MacBook Air configurations with quiet performance and long battery life." },
  { modelName: "MacBook Air 15-inch (M5)", family: "MacBook", basePrice: 1399, storages: ["256GB", "512GB", "1TB", "2TB"], description: "Large-screen MacBook Air options that balance portability with workspace comfort." },
  { modelName: "MacBook Pro 14-inch (M5)", family: "MacBook", basePrice: 1599, storages: ["512GB", "1TB", "2TB"], description: "Entry MacBook Pro configurations with active cooling and strong sustained performance." },
  { modelName: "MacBook Pro 14-inch (M5 Pro)", family: "MacBook", basePrice: 1999, storages: ["512GB", "1TB", "2TB", "4TB"], description: "High-performance 14-inch MacBook Pro configurations for demanding professional workflows." },
  { modelName: "MacBook Pro 14-inch (M5 Max)", family: "MacBook", basePrice: 3199, storages: ["1TB", "2TB", "4TB", "8TB"], description: "Top-tier 14-inch MacBook Pro options for advanced creative and compute-heavy tasks." },
  { modelName: "MacBook Pro 16-inch (M5 Pro)", family: "MacBook", basePrice: 2799, storages: ["512GB", "1TB", "2TB", "4TB"], description: "Large-screen MacBook Pro configurations with excellent thermal headroom and endurance." },
  { modelName: "MacBook Pro 16-inch (M5 Max)", family: "MacBook", basePrice: 3999, storages: ["1TB", "2TB", "4TB", "8TB"], description: "Highest-end MacBook Pro lineup for studio-grade editing, design, and development workloads." },
];

function buildVariations(definition) {
  const colors = familyColors[definition.family];
  const image = familyVariationImage[definition.family];

  return definition.storages.map((storage, index) => {
    const color = colors[index % colors.length];
    const price = definition.basePrice + (storageAdjustments[storage] || 0);
    const discountPrice = Math.max(price - Math.round(price * 0.05), price - 120);
    const originalPrice = price + Math.max(180, Math.round(price * 0.14));

    return {
      storage,
      color,
      price,
      discountPrice,
      originalPrice,
      reviewScore: Number((4.7 + ((index % 3) * 0.1)).toFixed(1)),
      peopleReviewed: 36 + index * 17,
      condition: conditionCycle[index % conditionCycle.length],
      image,
    };
  });
}

const catalog = catalogDefinitions.map((definition) => ({
  modelName: definition.modelName,
  description: definition.description,
  images: familyImages[definition.family],
  variations: buildVariations(definition),
}));

async function seed() {
  connectToDb();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (resetMode) {
    await Promise.all([
      ParentProduct.deleteMany({}),
      SingleVariation.deleteMany({}),
      AvailableCatagories.deleteMany({}),
    ]);
  }

  const createdParents = [];

  for (const item of catalog) {
    let parent = await ParentProduct.findOne({ modelName: item.modelName });
    if (!parent) {
      parent = await ParentProduct.create({
        modelName: item.modelName,
        description: item.description,
        images: item.images,
      });
    } else {
      parent.description = item.description;
      parent.images = item.images;
      await parent.save();
    }

    createdParents.push(parent);

    for (const variation of item.variations) {
      const existing = await SingleVariation.findOne({
        parentCatagory: parent._id,
        storage: variation.storage,
        "color.name": variation.color.name,
        condition: variation.condition,
      });

      if (!existing) {
        await SingleVariation.create({
          parentCatagory: parent._id,
          productName: item.modelName,
          description: item.description,
          ...variation,
        });
      } else {
        Object.assign(existing, {
          productName: item.modelName,
          description: item.description,
          ...variation,
        });
        await existing.save();
      }
    }
  }

  const categoryNames = createdParents.map((item) => item.modelName);
  const available = await AvailableCatagories.findOne();
  if (!available) {
    await AvailableCatagories.create({ categories: categoryNames });
  } else {
    available.categories = categoryNames;
    await available.save();
  }

  console.log(`Seeded ${createdParents.length} parent categories and demo variations successfully.`);
  await disconnectDb();
}

seed()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Failed to seed demo data:", error);
    await disconnectDb();
    process.exit(1);
  });
