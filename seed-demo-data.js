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

const appleColorValues = {
  "Alpine Green": "#5f6f64",
  "Black": "#2f3033",
  "Black Titanium": "#3c3c3d",
  "Blue": "#7a90a8",
  "Blue Titanium": "#6f7c8d",
  "Cloud White": "#f5f4ef",
  "Cosmic Orange": "#d98a57",
  "Deep Blue": "#3f5f9a",
  "Deep Purple": "#594f63",
  "Desert Titanium": "#b08d74",
  "Gold": "#d7c0a7",
  "Graphite": "#4e5054",
  "Green": "#5b7c68",
  "Lavender": "#c6bfdc",
  "Light Gold": "#e2d2b7",
  "Midnight": "#2f3135",
  "Mist Blue": "#b7cbe0",
  "Natural Titanium": "#b7b1a8",
  "Natural": "#b7b1a8",
  "Pink": "#e8b7c7",
  "Purple": "#b5a6d6",
  "(PRODUCT)RED": "#bf1e2d",
  "Rose Gold": "#e7b9b2",
  "Sage": "#aeb9a4",
  "Sierra Blue": "#a7bdd4",
  "Silver": "#d8dadc",
  "Sky Blue": "#afc6dd",
  "Soft Pink": "#f0d6db",
  "Space Black": "#2f3135",
  "Starlight": "#f0e8da",
  "Teal": "#6fa7a1",
  "Ultramarine": "#5f79d6",
  "White": "#f5f5f0",
  "White Titanium": "#e4e5e2",
  "Yellow": "#e6da8a",
};

const toColorObjects = (names) =>
  names.map((name) => ({
    name,
    value: appleColorValues[name] || "#d1d5db",
  }));

const iphoneCatalogDefinitions = [
  {
    modelName: "iPhone 13 mini",
    basePrice: 499,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Pink", "Blue", "Midnight", "Starlight", "(PRODUCT)RED", "Green"]),
    description: "Compact iPhone configurations for customers who prefer a smaller form factor.",
  },
  {
    modelName: "iPhone 13",
    basePrice: 529,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Pink", "Blue", "Midnight", "Starlight", "(PRODUCT)RED", "Green"]),
    description: "Well-rounded iPhone models that remain a strong entry point into the lineup.",
  },
  {
    modelName: "iPhone 13 Pro",
    basePrice: 679,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Graphite", "Gold", "Silver", "Sierra Blue", "Alpine Green"]),
    description: "Compact iPhone Pro options with triple-camera flexibility and strong performance.",
  },
  {
    modelName: "iPhone 13 Pro Max",
    basePrice: 779,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Graphite", "Gold", "Silver", "Sierra Blue", "Alpine Green"]),
    description: "Large iPhone Pro configurations with extended battery life and premium features.",
  },
  {
    modelName: "iPhone 14",
    basePrice: 599,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Midnight", "Starlight", "Blue", "Purple", "(PRODUCT)RED", "Yellow"]),
    description: "Reliable iPhone models with proven camera performance and smooth daily use.",
  },
  {
    modelName: "iPhone 14 Plus",
    basePrice: 699,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Midnight", "Starlight", "Blue", "Purple", "(PRODUCT)RED", "Yellow"]),
    description: "Spacious iPhone options with a larger screen and all-day battery life.",
  },
  {
    modelName: "iPhone 14 Pro",
    basePrice: 849,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Space Black", "Silver", "Gold", "Deep Purple"]),
    description: "Refined iPhone Pro options with standout camera and display quality.",
  },
  {
    modelName: "iPhone 14 Pro Max",
    basePrice: 949,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Space Black", "Silver", "Gold", "Deep Purple"]),
    description: "Large-screen iPhone Pro options with premium imaging and battery endurance.",
  },
  {
    modelName: "iPhone 15",
    basePrice: 699,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Pink", "Yellow", "Green", "Blue", "Black"]),
    description: "Refined iPhone configurations that still deliver strong everyday value.",
  },
  {
    modelName: "iPhone 15 Plus",
    basePrice: 799,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Pink", "Yellow", "Green", "Blue", "Black"]),
    description: "Large-format iPhone options with dependable battery life and bright displays.",
  },
  {
    modelName: "iPhone 15 Pro",
    basePrice: 949,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Natural Titanium", "Blue Titanium", "White Titanium", "Black Titanium"]),
    description: "Premium titanium iPhone configurations built for power users and creators.",
  },
  {
    modelName: "iPhone 15 Pro Max",
    basePrice: 1099,
    storages: ["256GB", "512GB", "1TB"],
    colors: toColorObjects(["Natural Titanium", "Blue Titanium", "White Titanium", "Black Titanium"]),
    description: "Flagship titanium iPhone configurations with premium finish options.",
  },
  {
    modelName: "iPhone 16",
    basePrice: 799,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Black", "White", "Pink", "Teal", "Ultramarine"]),
    description: "Current iPhone lineup with balanced performance, camera quality, and battery life.",
  },
  {
    modelName: "iPhone 16 Plus",
    basePrice: 899,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Black", "White", "Pink", "Teal", "Ultramarine"]),
    description: "Large-screen iPhone options with strong battery life and everyday versatility.",
  },
  {
    modelName: "iPhone 16 Pro",
    basePrice: 999,
    storages: ["128GB", "256GB", "512GB", "1TB"],
    colors: toColorObjects(["Black Titanium", "White Titanium", "Natural Titanium", "Desert Titanium"]),
    description: "Professional-grade iPhone configurations with flagship camera and display features.",
  },
  {
    modelName: "iPhone 16 Pro Max",
    basePrice: 1199,
    storages: ["256GB", "512GB", "1TB"],
    colors: toColorObjects(["Black Titanium", "White Titanium", "Natural Titanium", "Desert Titanium"]),
    description: "Top-tier iPhone lineup with the largest display and premium feature set.",
  },
  {
    modelName: "iPhone 16e",
    basePrice: 699,
    storages: ["128GB", "256GB", "512GB"],
    colors: toColorObjects(["Black", "White", "Ultramarine"]),
    description: "Value-focused current-generation iPhone configurations with modern performance.",
  },
  {
    modelName: "iPhone 17",
    basePrice: 899,
    storages: ["256GB", "512GB"],
    colors: toColorObjects(["Black", "White", "Lavender", "Sage", "Mist Blue"]),
    description: "Next-generation iPhone configurations with a refreshed palette and larger default storage tiers.",
  },
  {
    modelName: "iPhone Air",
    basePrice: 999,
    storages: ["256GB", "512GB", "1TB"],
    colors: toColorObjects(["Space Black", "Cloud White", "Light Gold", "Sky Blue"]),
    description: "Thin-and-light premium iPhone configurations designed around portability and modern finishes.",
  },
  {
    modelName: "iPhone 17 Pro",
    basePrice: 1199,
    storages: ["256GB", "512GB", "1TB"],
    colors: toColorObjects(["Silver", "Deep Blue", "Cosmic Orange"]),
    description: "Pro-level next-generation iPhone options with higher baseline storage and standout finishes.",
  },
  {
    modelName: "iPhone 17 Pro Max",
    basePrice: 1399,
    storages: ["256GB", "512GB", "1TB", "2TB"],
    colors: toColorObjects(["Silver", "Deep Blue", "Cosmic Orange"]),
    description: "Largest next-generation iPhone Pro lineup with premium storage tiers and flagship positioning.",
  },
  {
    modelName: "iPhone 17e",
    basePrice: 799,
    storages: ["256GB", "512GB"],
    colors: toColorObjects(["Black", "White", "Soft Pink"]),
    description: "Entry-focused next-generation iPhone configurations with simplified finish and storage options.",
  },
].map((definition) => ({
  ...definition,
  family: "iPhone",
}));

const ipadColors = {
  standardLegacy: toColorObjects(["Space Gray", "Silver", "Gold"]),
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
  standardModern: toColorObjects(["Blue", "Pink", "Yellow", "Silver"]),
  airLegacy: toColorObjects(["Space Gray", "Silver", "Gold", "Rose Gold"]),
  airFourthGen: toColorObjects(["Space Gray", "Silver", "Rose Gold", "Green", "Sky Blue"]),
  airFifthGen: toColorObjects(["Space Gray", "Starlight", "Pink", "Purple", "Blue"]),
  miniLegacy: toColorObjects(["Space Gray", "Silver", "Gold"]),
  miniSixthGen: toColorObjects(["Space Gray", "Pink", "Purple", "Starlight"]),
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

const ipadCatalogDefinitions = [
  { modelName: "iPad 7th Gen", family: "iPad", basePrice: 199, storages: ["32GB", "128GB"], colors: ipadColors.standardLegacy, description: "Seventh-generation iPad configurations that remain a budget-friendly option for everyday browsing and learning." },
  { modelName: "iPad 8th Gen", family: "iPad", basePrice: 229, storages: ["32GB", "128GB"], colors: ipadColors.standardLegacy, description: "Reliable eighth-generation iPad models for school, streaming, and light productivity." },
  { modelName: "iPad 9th Gen", family: "iPad", basePrice: 249, storages: ["64GB", "256GB"], colors: ipadColors.legacy, description: "Affordable classic-design iPad configurations for browsing, school, and light productivity." },
  { modelName: "iPad 10th Gen", family: "iPad", basePrice: 299, storages: ["64GB", "256GB"], colors: ipadColors.standardModern, description: "Colorful tenth-generation iPad options that remain a popular everyday choice." },
  { modelName: "iPad 11th Gen", family: "iPad", basePrice: 349, storages: ["128GB", "256GB", "512GB"], colors: ipadColors.standardModern, description: "Latest standard iPad lineup for school, browsing, and everyday productivity." },
  { modelName: "iPad mini 5th Gen", family: "iPad", basePrice: 299, storages: ["64GB", "256GB"], colors: ipadColors.miniLegacy, description: "Compact fifth-generation iPad mini models built for portability and light creative work." },
  { modelName: "iPad mini 6th Gen", family: "iPad", basePrice: 399, storages: ["64GB", "256GB"], colors: ipadColors.miniSixthGen, description: "Compact iPad mini models with modern design and strong everyday portability." },
  { modelName: "iPad mini 7th Gen", family: "iPad", basePrice: 499, storages: ["128GB", "256GB"], colors: ipadColors.mini, description: "Newest iPad mini lineup with upgraded storage and a portable premium form factor." },
  { modelName: "iPad Air 3rd Gen (10.5-inch)", family: "iPad", basePrice: 349, storages: ["64GB", "256GB"], colors: ipadColors.airLegacy, description: "Third-generation iPad Air models that balance portability with dependable everyday performance." },
  { modelName: "iPad Air 4th Gen (10.9-inch)", family: "iPad", basePrice: 399, storages: ["64GB", "256GB"], colors: ipadColors.airFourthGen, description: "Fourth-generation iPad Air configurations with a modern all-screen design and colorful finishes." },
  { modelName: "iPad Air 5th Gen (10.9-inch)", family: "iPad", basePrice: 449, storages: ["64GB", "256GB"], colors: ipadColors.airFifthGen, description: "Fifth-generation iPad Air options with strong everyday value for study, work, and drawing." },
  { modelName: "iPad Air 11-inch (M2)", family: "iPad", basePrice: 549, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "11-inch iPad Air models with Apple silicon performance and flexible accessory support." },
  { modelName: "iPad Air 13-inch (M2)", family: "iPad", basePrice: 749, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "13-inch iPad Air configurations that add more screen space for notes, art, and multitasking." },
  { modelName: "iPad Air 11-inch (M3)", family: "iPad", basePrice: 599, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "11-inch iPad Air models with M3 performance for study, design, and creative work." },
  { modelName: "iPad Air 13-inch (M3)", family: "iPad", basePrice: 799, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "13-inch iPad Air configurations with M3 and added room for multitasking and drawing." },
  { modelName: "iPad Air 11-inch (M4)", family: "iPad", basePrice: 649, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "Latest 11-inch iPad Air options with upgraded Apple silicon and lightweight versatility." },
  { modelName: "iPad Air 13-inch (M4)", family: "iPad", basePrice: 849, storages: ["128GB", "256GB", "512GB", "1TB"], colors: ipadColors.air, description: "Latest 13-inch iPad Air lineup for users who want more display space with Air portability." },
  { modelName: "iPad Pro 11-inch (2nd Gen)", family: "iPad", basePrice: 549, storages: ["128GB", "256GB", "512GB", "1TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Second-generation 11-inch iPad Pro models with strong performance for creative and professional work." },
  { modelName: "iPad Pro 12.9-inch (4th Gen)", family: "iPad", basePrice: 749, storages: ["128GB", "256GB", "512GB", "1TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Fourth-generation 12.9-inch iPad Pro configurations with a large display and pro-level flexibility." },
  { modelName: "iPad Pro 11-inch (3rd Gen)", family: "iPad", basePrice: 649, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Third-generation 11-inch iPad Pro models that remain strong options for creative and professional use." },
  { modelName: "iPad Pro 12.9-inch (5th Gen)", family: "iPad", basePrice: 849, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Fifth-generation 12.9-inch iPad Pro configurations with premium display quality and pro-level performance." },
  { modelName: "iPad Pro 11-inch (4th Gen)", family: "iPad", basePrice: 749, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Fourth-generation 11-inch iPad Pro models with ProMotion, Face ID, and strong creative performance." },
  { modelName: "iPad Pro 12.9-inch (6th Gen)", family: "iPad", basePrice: 949, storages: ["128GB", "256GB", "512GB", "1TB", "2TB"], colors: toColorObjects(["Space Gray", "Silver"]), description: "Sixth-generation 12.9-inch iPad Pro configurations with mini-LED display and workstation-class power." },
  { modelName: "iPad Pro 11-inch (M4)", family: "iPad", basePrice: 899, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Ultra-thin 11-inch iPad Pro options built for creators, editing, and advanced multitasking." },
  { modelName: "iPad Pro 13-inch (M4)", family: "iPad", basePrice: 1199, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "13-inch tandem OLED iPad Pro models with exceptional display quality and portability." },
  { modelName: "iPad Pro 11-inch (M5)", family: "iPad", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Compact iPad Pro configurations built for demanding creative and professional work." },
  { modelName: "iPad Pro 13-inch (M5)", family: "iPad", basePrice: 1299, storages: ["256GB", "512GB", "1TB", "2TB"], colors: ipadColors.pro, description: "Large-format iPad Pro lineup designed for creators, editors, and multitaskers." },
];

const macbookCatalogDefinitions = [
  { modelName: "MacBook Air 13-inch (M1)", family: "MacBook", basePrice: 649, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM1, description: "Original Apple silicon MacBook Air models that remain a strong lightweight everyday pick." },
  { modelName: "MacBook Air 13-inch (M2)", family: "MacBook", basePrice: 799, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "Redesigned 13-inch MacBook Air options with improved display, webcam, and battery life." },
  { modelName: "MacBook Air 15-inch (M2)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "15-inch MacBook Air models that balance a larger display with quiet, fanless portability." },
  { modelName: "MacBook Air 13-inch (M3)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "13-inch MacBook Air configurations with faster Apple silicon and excellent all-day efficiency." },
  { modelName: "MacBook Air 15-inch (M3)", family: "MacBook", basePrice: 1199, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.airM2M3, description: "15-inch MacBook Air models for customers who want more screen without stepping into Pro territory." },
  { modelName: "MacBook Air 13-inch (M4)", family: "MacBook", basePrice: 1099, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.air, description: "13-inch MacBook Air models with M4 for fast everyday work, study, and creative tasks." },
  { modelName: "MacBook Air 15-inch (M4)", family: "MacBook", basePrice: 1299, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.air, description: "15-inch MacBook Air configurations with M4 for customers who want more display space without extra bulk." },
  { modelName: "MacBook Air 13-inch (M5)", family: "MacBook", basePrice: 1199, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.air, description: "Thin-and-light MacBook Air configurations with quiet performance and long battery life." },
  { modelName: "MacBook Air 15-inch (M5)", family: "MacBook", basePrice: 1399, storages: ["512GB", "1TB", "2TB", "4TB"], colors: macbookColors.air, description: "Large-screen MacBook Air options that balance portability with workspace comfort." },
  { modelName: "MacBook Pro 13-inch (M1)", family: "MacBook", basePrice: 849, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.pro13, description: "Compact Touch Bar MacBook Pro models powered by first-generation Apple silicon." },
  { modelName: "MacBook Pro 13-inch (M2)", family: "MacBook", basePrice: 999, storages: ["256GB", "512GB", "1TB", "2TB"], colors: macbookColors.pro13, description: "13-inch MacBook Pro models with M2 for customers who prefer the classic compact Pro format." },
  { modelName: "MacBook Pro 14-inch (M1 Pro)", family: "MacBook", basePrice: 1399, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "14-inch MacBook Pro models with M1 Pro for serious editing, coding, and production workflows." },
  { modelName: "MacBook Pro 14-inch (M1 Max)", family: "MacBook", basePrice: 1999, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "High-end 14-inch MacBook Pro configurations built for advanced creative and technical work." },
  { modelName: "MacBook Pro 16-inch (M1 Pro)", family: "MacBook", basePrice: 1799, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "Large-screen M1 Pro MacBook Pro models with strong battery life and sustained performance." },
  { modelName: "MacBook Pro 16-inch (M1 Max)", family: "MacBook", basePrice: 2399, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "16-inch MacBook Pro options with M1 Max for heavy graphics, rendering, and studio workloads." },
  { modelName: "MacBook Pro 14-inch (M2 Pro)", family: "MacBook", basePrice: 1599, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "14-inch MacBook Pro models with M2 Pro for upgraded speed and dependable professional workflows." },
  { modelName: "MacBook Pro 14-inch (M2 Max)", family: "MacBook", basePrice: 2299, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "14-inch M2 Max MacBook Pro configurations tuned for advanced creative and compute-heavy tasks." },
  { modelName: "MacBook Pro 16-inch (M2 Pro)", family: "MacBook", basePrice: 2099, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "16-inch MacBook Pro models with M2 Pro for users who need more room and stronger sustained throughput." },
  { modelName: "MacBook Pro 16-inch (M2 Max)", family: "MacBook", basePrice: 2899, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.proClassic, description: "Top-tier 16-inch M2 Max MacBook Pro options for design, video, 3D, and development workloads." },
  { modelName: "MacBook Pro 14-inch (M3)", family: "MacBook", basePrice: 1499, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro13, description: "Entry 14-inch MacBook Pro models with M3 for users who want active cooling and premium displays." },
  { modelName: "MacBook Pro 14-inch (M3 Pro)", family: "MacBook", basePrice: 1899, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "14-inch MacBook Pro configurations with M3 Pro for advanced multitasking and pro applications." },
  { modelName: "MacBook Pro 14-inch (M3 Max)", family: "MacBook", basePrice: 2999, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "14-inch M3 Max MacBook Pro options designed for intensive rendering, VFX, and AI workflows." },
  { modelName: "MacBook Pro 16-inch (M3 Pro)", family: "MacBook", basePrice: 2499, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "16-inch MacBook Pro models with M3 Pro for demanding professional work with more thermal headroom." },
  { modelName: "MacBook Pro 16-inch (M3 Max)", family: "MacBook", basePrice: 3499, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "High-end 16-inch MacBook Pro configurations for studio-grade video, 3D, and technical workloads." },
  { modelName: "MacBook Pro 14-inch (M4)", family: "MacBook", basePrice: 1549, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro, description: "14-inch MacBook Pro models with M4 that deliver a balanced entry point into the modern Pro lineup." },
  { modelName: "MacBook Pro 14-inch (M4 Pro)", family: "MacBook", basePrice: 1949, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "14-inch M4 Pro MacBook Pro options for advanced editing, development, and demanding multitasking." },
  { modelName: "MacBook Pro 14-inch (M4 Max)", family: "MacBook", basePrice: 3099, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Top-tier 14-inch MacBook Pro configurations with M4 Max for intensive pro workloads." },
  { modelName: "MacBook Pro 16-inch (M4 Pro)", family: "MacBook", basePrice: 2699, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "16-inch MacBook Pro models with M4 Pro for users who need more screen space and sustained performance." },
  { modelName: "MacBook Pro 16-inch (M4 Max)", family: "MacBook", basePrice: 3899, storages: ["512GB", "1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Highest-end 16-inch M4 Max MacBook Pro options for studio, engineering, and compute-heavy workflows." },
  { modelName: "MacBook Pro 14-inch (M5)", family: "MacBook", basePrice: 1599, storages: ["512GB", "1TB", "2TB"], colors: macbookColors.pro, description: "Entry MacBook Pro configurations with active cooling and strong sustained performance." },
  { modelName: "MacBook Pro 14-inch (M5 Pro)", family: "MacBook", basePrice: 2199, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "High-performance 14-inch MacBook Pro configurations for demanding professional workflows." },
  { modelName: "MacBook Pro 14-inch (M5 Max)", family: "MacBook", basePrice: 3199, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Top-tier 14-inch MacBook Pro options for advanced creative and compute-heavy tasks." },
  { modelName: "MacBook Pro 16-inch (M5 Pro)", family: "MacBook", basePrice: 2999, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Large-screen MacBook Pro configurations with excellent thermal headroom and endurance." },
  { modelName: "MacBook Pro 16-inch (M5 Max)", family: "MacBook", basePrice: 3999, storages: ["1TB", "2TB", "4TB", "8TB"], colors: macbookColors.pro, description: "Highest-end MacBook Pro lineup for studio-grade editing, design, and development workloads." },
];

const storageAdjustments = {
  "32GB": -80,
  "64GB": -40,
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
    if (modelName.includes("14-inch") || modelName.includes('14"') || modelName.includes("13-inch") || modelName.includes('13"')) return productImageLibrary.macbookPro14;
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
  ...iphoneCatalogDefinitions,
  ...ipadCatalogDefinitions,
  ...macbookCatalogDefinitions,
];

function buildVariations(definition) {
  const colors = definition.colors || familyColors[definition.family];
  const image = getProductImage(definition);

  return definition.storages.flatMap((storage, storageIndex) => {
    return colors.map((color, colorIndex) => {
    const index = storageIndex * colors.length + colorIndex;
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

    const existingVariants = await SingleVariation.find({ parentCatagory: parent._id });
    const existingByKey = new Map();

    for (const variant of existingVariants) {
      const key = `${variant.storage || ""}::${variant.color?.name || ""}`;
      const variantsForKey = existingByKey.get(key) || [];
      variantsForKey.push(variant);
      existingByKey.set(key, variantsForKey);
    }

    const desiredKeys = new Set();

    for (const variation of item.variations) {
      const key = `${variation.storage || ""}::${variation.color?.name || ""}`;
      desiredKeys.add(key);
      const candidates = existingByKey.get(key) || [];
      const existing = candidates.shift();

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

    const staleIds = [];

    for (const [key, variants] of existingByKey.entries()) {
      if (!desiredKeys.has(key)) {
        staleIds.push(...variants.map((variant) => variant._id));
        continue;
      }

      if (variants.length) {
        staleIds.push(...variants.map((variant) => variant._id));
      }
    }

    if (staleIds.length) {
      await SingleVariation.deleteMany({ _id: { $in: staleIds } });
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
