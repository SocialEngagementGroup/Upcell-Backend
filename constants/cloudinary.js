const crypto = require("crypto");

// Cloudinary asset layout for UpCell.
//
// Everything lives under one root so the media library stays navigable and a
// stray upload is immediately obvious. The folder list is fixed and
// allowlisted: the signature endpoint refuses to sign anything outside this
// tree, so a leaked or misused admin token cannot overwrite unrelated assets.
//
//   upcell/
//   |-- products/<family>/     iphone | ipad | macbook | accessory | other
//   |-- categories/            shop category tiles (admin-managed)
//   |-- marketing/hero/        homepage and landing heroes
//   |-- marketing/ads/         ad slots
//   `-- static/                site chrome that still benefits from f_auto
//
// Logos and the favicon deliberately stay in Frontend/public: they are SVG or
// tiny PNG, f_auto cannot improve vector art, and the app shell should not
// block on a third-party host.
const CLOUDINARY_ROOT = "upcell";

const PRODUCT_FAMILIES = ["iphone", "ipad", "macbook", "accessory", "other"];

const CLOUDINARY_FOLDERS = {
  PRODUCTS: `${CLOUDINARY_ROOT}/products`,
  CATEGORIES: `${CLOUDINARY_ROOT}/categories`,
  MARKETING_HERO: `${CLOUDINARY_ROOT}/marketing/hero`,
  MARKETING_ADS: `${CLOUDINARY_ROOT}/marketing/ads`,
  STATIC: `${CLOUDINARY_ROOT}/static`,
};

// Product uploads are additionally allowed one level deeper, one folder per
// family, so the library mirrors how the catalogue is actually browsed.
const PRODUCT_FAMILY_FOLDERS = PRODUCT_FAMILIES.map(
  (family) => `${CLOUDINARY_FOLDERS.PRODUCTS}/${family}`
);

const ALLOWED_UPLOAD_FOLDERS = [
  ...Object.values(CLOUDINARY_FOLDERS),
  ...PRODUCT_FAMILY_FOLDERS,
];

function isAllowedFolder(folder) {
  return ALLOWED_UPLOAD_FOLDERS.includes(folder);
}

// Maps free-text product/category naming onto one of the fixed family folders.
// Anything unrecognised lands in "other" rather than creating a new folder, so
// the tree cannot grow sideways from user input.
function resolveProductFamily(value) {
  const text = String(value || "").toLowerCase();

  if (text.includes("iphone")) return "iphone";
  if (text.includes("ipad")) return "ipad";
  if (text.includes("macbook")) return "macbook";
  if (text.includes("accessor")) return "accessory";

  return "other";
}

function productFolder(value) {
  return `${CLOUDINARY_FOLDERS.PRODUCTS}/${resolveProductFamily(value)}`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// public_id algorithm: <slug>--<hash8>
//
//   slug   kebab-case of the descriptive parts (model, colour, variant), so a
//          human can find an asset in the Cloudinary UI by reading the name
//   hash8  first 8 hex characters of sha1(sourceKey)
//
// The hash does two jobs. It disambiguates products that slugify identically
// (two "blue" iPad Airs from different source files), and it makes re-uploads
// idempotent: the same source always produces the same id, so Cloudinary
// overwrites in place instead of accumulating near-duplicates.
//
// Deriving the id rather than storing a lookup table is the point — given a
// product's family, name and colour you can compute exactly where its image
// lives without querying anything.
function buildPublicId({ parts = [], sourceKey }) {
  const slug = parts.map(slugify).filter(Boolean).join("-") || "asset";
  const hash = crypto
    .createHash("sha1")
    .update(String(sourceKey || slug))
    .digest("hex")
    .slice(0, 8);

  return `${slug}--${hash}`;
}

module.exports = {
  CLOUDINARY_ROOT,
  CLOUDINARY_FOLDERS,
  PRODUCT_FAMILIES,
  PRODUCT_FAMILY_FOLDERS,
  ALLOWED_UPLOAD_FOLDERS,
  isAllowedFolder,
  resolveProductFamily,
  productFolder,
  slugify,
  buildPublicId,
};
