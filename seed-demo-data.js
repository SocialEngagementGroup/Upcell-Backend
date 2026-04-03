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

const productImageLibrary = {
  ipadStandard: "/product-images/apple-source/ipad-a16.jpg",
  ipadMini: "/product-images/apple-source/ipad-mini-a17-pro.jpg",
  ipadAir: "/product-images/apple-source/ipad-air-m4.jpg",
  ipadPro: "/product-images/apple-source/ipad-pro-m5.jpg",
  macbookAir: "/product-images/apple-source/macbook-air-m5.jpg",
  macbookPro14: "/product-images/apple-source/macbook-pro-m5.jpg",
  macbookPro: "/product-images/apple-source/macbook-pro-m5-pro-max.jpg",
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

const ipadColors = {
  legacy: [
    { name: "Space Gray", value: "#6F747C" },
    { name: "Silver", value: "#E3E5E6" },
  ],
  standard: [
    { name: "Silver", value: "#E3E5E6" },
    { name: "Blue", value: "#8EABC8" },
    { name: "Pink", value: "#E8B7C7" },
    { name: "Yellow", value: "#E6DA8A" },
  ],
  mini: [
    { name: "Blue", value: "#89A7C6" },
    { name: "Purple", value: "#B5A6D6" },
    { name: "Starlight", value: "#F0E8DA" },
    { name: "Space Gray", value: "#6F747C" },
  ],
  air: [
    { name: "Space Gray", value: "#6F747C" },
    { name: "Blue", value: "#9CB2C9" },
    { name: "Purple", value: "#B7A1D7" },
    { name: "Starlight", value: "#F0E8DA" },
  ],
  pro: [
    { name: "Space Black", value: "#2F3135" },
    { name: "Silver", value: "#D8DADC" },
  ],
};

const macbookColors = {
  airM1: [
    { name: "Space Gray", value: "#62666C" },
    { name: "Silver", value: "#D8DADC" },
    { name: "Gold", value: "#D8C1A6" },
  ],
  airM2M3: [
    { name: "Midnight", value: "#2C3440" },
    { name: "Starlight", value: "#F0E8DA" },
    { name: "Silver", value: "#D8DADC" },
    { name: "Space Gray", value: "#62666C" },
  ],
  air: [
    { name: "Sky Blue", value: "#AFC6DD" },
    { name: "Silver", value: "#D8DADC" },
    { name: "Starlight", value: "#F0E8DA" },
    { name: "Midnight", value: "#2C3440" },
  ],
  pro13: [
    { name: "Space Gray", value: "#62666C" },
    { name: "Silver", value: "#D8DADC" },
  ],
  proClassic: [
    { name: "Space Gray", value: "#62666C" },
    { name: "Silver", value: "#D8DADC" },
  ],
  pro: [
    { name: "Space Black", value: "#2F3135" },
    { name: "Silver", value: "#D8DADC" },
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

function getProductImage(definition) {
  const { family, modelName } = definition;

  if (family === "iPad") {
    if (modelName.includes("mini")) return productImageLibrary.ipadMini;
    if (modelName.includes("Air")) return productImageLibrary.ipadAir;
    if (modelName.includes("Pro")) return productImageLibrary.ipadPro;
    return productImageLibrary.ipadStandard;
  }

  if (family === "MacBook") {
    if (modelName.includes("Air")) return productImageLibrary.macbookAir;
    if (modelName.includes("14-inch") || modelName.includes("13-inch")) return productImageLibrary.macbookPro14;
    return productImageLibrary.macbookPro;
  }

  return familyVariationImage[family];
}

function getParentImages(definition) {
  if (definition.family === "iPad" || definition.family === "MacBook") {
    const image = getProductImage(definition);
    return [{ url: image }];
  }

  return familyImages[definition.family];
}

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
  { modelName: "iPad (A16)", family: "iPad", basePrice: 349, storages: ["128GB", "256GB", "512GB"], colors: ipadColors.standard, description: "Current standard iPad options for school, browsing, and everyday productivity." },
  { modelName: "iPad (10th Gen)", family: "iPad", basePrice: 299, storages: ["64GB", "256GB"], colors: ipadColors.standard, description: "Colorful 10th-generation iPad options that remain a popular everyday choice." },
  { modelName: "iPad (9th Gen)", family: "iPad", basePrice: 249, storages: ["64GB", "256GB"], colors: ipadColors.legacy, description: "Affordable classic-design iPad configurations for browsing, school, and light productivity." },
  { modelName: "iPad mini (A17 Pro)", family: "iPad", basePrice: 499, storages: ["128GB", "256GB", "512GB"], colors: ipadColors.mini, description: "Portable iPad mini configurations that balance power with a compact footprint." },
  { modelName: "iPad mini (6th Gen)", family: "iPad", basePrice: 399, storages: ["64GB", "256GB"], colors: ipadColors.mini, description: "Compact iPad mini models with modern design and strong everyday portability." },
  { modelName: "iPad Air (5th Gen)", family: "iPad", basePrice: 449, storages: ["64GB", "256GB"], colors: ipadColors.air, description: "M1-powered iPad Air configurations that still offer excellent value for work and study." },
  { modelName: "iPad Pro 11-inch (M1)", family: "iPad", basePrice: 649, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "11-inch M1 iPad Pro models that remain strong options for creative and professional use." },
  { modelName: "iPad Pro 12.9-inch (M1)", family: "iPad", basePrice: 849, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "12.9-inch M1 iPad Pro configurations with premium display quality and pro-level performance." },
  { modelName: "iPad Air 11-inch (M2)", family: "iPad", basePrice: 549, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "11-inch iPad Air models with Apple silicon performance and flexible accessory support." },
  { modelName: "iPad Air 13-inch (M2)", family: "iPad", basePrice: 749, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "13-inch iPad Air configurations that add more screen space for notes, art, and multitasking." },
  { modelName: "iPad Air 11-inch (M4)", family: "iPad", basePrice: 599, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "Lightweight iPad Air options with laptop-class performance for flexible work." },
  { modelName: "iPad Air 13-inch (M4)", family: "iPad", basePrice: 799, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "Large-screen iPad Air configurations ideal for study, drawing, and multitasking." },
  { modelName: "iPad Pro 11-inch (M2)", family: "iPad", basePrice: 749, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "11-inch iPad Pro models with ProMotion, Face ID, and strong creative performance." },
  { modelName: "iPad Pro 12.9-inch (M2)", family: "iPad", basePrice: 949, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Large-screen iPad Pro configurations with mini-LED display and workstation-class power." },
  { modelName: "iPad Pro 11-inch (M4)", family: "iPad", basePrice: 899, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Ultra-thin 11-inch iPad Pro options built for creators, editing, and advanced multitasking." },
  { modelName: "iPad Pro 13-inch (M4)", family: "iPad", basePrice: 1199, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "13-inch tandem OLED iPad Pro models with exceptional display quality and portability." },
  { modelName: "iPad Pro 11-inch (M5)", family: "iPad", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Compact iPad Pro configurations built for demanding creative and professional work." },
  { modelName: "iPad Pro 13-inch (M5)", family: "iPad", basePrice: 1299, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Large-format iPad Pro lineup designed for creators, editors, and multitaskers." },
  { modelName: "MacBook Air 13-inch (M1)", family: "MacBook", basePrice: 649, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM1, description: "Original Apple silicon MacBook Air models that remain a strong lightweight everyday pick." },
  { modelName: "MacBook Air 13-inch (M2)", family: "MacBook", basePrice: 799, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "Redesigned 13-inch MacBook Air options with improved display, webcam, and battery life." },
  { modelName: "MacBook Air 15-inch (M2)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "15-inch MacBook Air models that balance a larger display with quiet, fanless portability." },
  { modelName: "MacBook Air 13-inch (M3)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "13-inch MacBook Air configurations with faster Apple silicon and excellent all-day efficiency." },
  { modelName: "MacBook Air 15-inch (M3)", family: "MacBook", basePrice: 1199, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "15-inch MacBook Air models for customers who want more screen without stepping into Pro territory." },
  { modelName: "MacBook Air 13-inch (M5)", family: "MacBook", basePrice: 1199, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.air, description: "Thin-and-light MacBook Air configurations with quiet performance and long battery life." },
  { modelName: "MacBook Air 15-inch (M5)", family: "MacBook", basePrice: 1399, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.air, description: "Large-screen MacBook Air options that balance portability with workspace comfort." },
  { modelName: "MacBook Pro 13-inch (M1)", family: "MacBook", basePrice: 849, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.pro13, description: "Compact Touch Bar MacBook Pro models powered by first-generation Apple silicon." },
  { modelName: "MacBook Pro 13-inch (M2)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.pro13, description: "13-inch MacBook Pro models with M2 for customers who prefer the classic compact Pro format." },
  { modelName: "MacBook Pro 14-inch (M1 Pro)", family: "MacBook", basePrice: 1399, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.proClassic, description: "14-inch MacBook Pro models with M1 Pro for serious editing, coding, and production workflows." },
  { modelName: "MacBook Pro 14-inch (M1 Max)", family: "MacBook", basePrice: 1999, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "High-end 14-inch MacBook Pro configurations built for advanced creative and technical work." },
  { modelName: "MacBook Pro 16-inch (M1 Pro)", family: "MacBook", basePrice: 1799, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.proClassic, description: "Large-screen M1 Pro MacBook Pro models with strong battery life and sustained performance." },
  { modelName: "MacBook Pro 16-inch (M1 Max)", family: "MacBook", basePrice: 2399, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "16-inch MacBook Pro options with M1 Max for heavy graphics, rendering, and studio workloads." },
  { modelName: "MacBook Pro 14-inch (M2 Pro)", family: "MacBook", basePrice: 1599, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.proClassic, description: "14-inch MacBook Pro models with M2 Pro for upgraded speed and dependable professional workflows." },
  { modelName: "MacBook Pro 14-inch (M2 Max)", family: "MacBook", basePrice: 2299, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "14-inch M2 Max MacBook Pro configurations tuned for advanced creative and compute-heavy tasks." },
  { modelName: "MacBook Pro 16-inch (M2 Pro)", family: "MacBook", basePrice: 2099, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.proClassic, description: "16-inch MacBook Pro models with M2 Pro for users who need more room and stronger sustained throughput." },
  { modelName: "MacBook Pro 16-inch (M2 Max)", family: "MacBook", basePrice: 2899, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "Top-tier 16-inch M2 Max MacBook Pro options for design, video, 3D, and development workloads." },
  { modelName: "MacBook Pro 14-inch (M3)", family: "MacBook", basePrice: 1499, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro, description: "Entry 14-inch MacBook Pro models with M3 for users who want active cooling and premium displays." },
  { modelName: "MacBook Pro 14-inch (M3 Pro)", family: "MacBook", basePrice: 1899, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "14-inch MacBook Pro configurations with M3 Pro for advanced multitasking and pro applications." },
  { modelName: "MacBook Pro 14-inch (M3 Max)", family: "MacBook", basePrice: 2999, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "14-inch M3 Max MacBook Pro options designed for intensive rendering, VFX, and AI workflows." },
  { modelName: "MacBook Pro 16-inch (M3 Pro)", family: "MacBook", basePrice: 2499, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "16-inch MacBook Pro models with M3 Pro for demanding professional work with more thermal headroom." },
  { modelName: "MacBook Pro 16-inch (M3 Max)", family: "MacBook", basePrice: 3499, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "High-end 16-inch MacBook Pro configurations for studio-grade video, 3D, and technical workloads." },
  { modelName: "MacBook Air 13-inch (M4)", family: "MacBook", basePrice: 1099, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "13-inch MacBook Air models with M4 for fast everyday work, study, and creative tasks." },
  { modelName: "MacBook Air 15-inch (M4)", family: "MacBook", basePrice: 1299, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "15-inch MacBook Air configurations with M4 for customers who want more display space without extra bulk." },
  { modelName: "MacBook Pro 14-inch (M4)", family: "MacBook", basePrice: 1549, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro, description: "14-inch MacBook Pro models with M4 that deliver a balanced entry point into the modern Pro lineup." },
  { modelName: "MacBook Pro 14-inch (M4 Pro)", family: "MacBook", basePrice: 1949, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "14-inch M4 Pro MacBook Pro options for advanced editing, development, and demanding multitasking." },
  { modelName: "MacBook Pro 14-inch (M4 Max)", family: "MacBook", basePrice: 3099, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Top-tier 14-inch MacBook Pro configurations with M4 Max for intensive pro workloads." },
  { modelName: "MacBook Pro 16-inch (M4 Pro)", family: "MacBook", basePrice: 2699, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "16-inch MacBook Pro models with M4 Pro for users who need more screen space and sustained performance." },
  { modelName: "MacBook Pro 16-inch (M4 Max)", family: "MacBook", basePrice: 3899, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Highest-end 16-inch M4 Max MacBook Pro options for studio, engineering, and compute-heavy workflows." },
  { modelName: "MacBook Pro 14-inch (M5)", family: "MacBook", basePrice: 1599, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro, description: "Entry MacBook Pro configurations with active cooling and strong sustained performance." },
  { modelName: "MacBook Pro 14-inch (M5 Pro)", family: "MacBook", basePrice: 1999, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "High-performance 14-inch MacBook Pro configurations for demanding professional workflows." },
  { modelName: "MacBook Pro 14-inch (M5 Max)", family: "MacBook", basePrice: 3199, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Top-tier 14-inch MacBook Pro options for advanced creative and compute-heavy tasks." },
  { modelName: "MacBook Pro 16-inch (M5 Pro)", family: "MacBook", basePrice: 2799, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.pro, description: "Large-screen MacBook Pro configurations with excellent thermal headroom and endurance." },
  { modelName: "MacBook Pro 16-inch (M5 Max)", family: "MacBook", basePrice: 3999, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Highest-end MacBook Pro lineup for studio-grade editing, design, and development workloads." },
];

function buildVariations(definition) {
  const colors = definition.colors || familyColors[definition.family];
  const image = getProductImage(definition);

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
  images: getParentImages(definition),
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
