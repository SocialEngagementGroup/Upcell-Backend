const { getCloudinaryConfig, buildUploadSignature } = require("../config/cloudinary");
const {
  CLOUDINARY_FOLDERS,
  isAllowedFolder,
  productFolder,
  buildPublicId,
} = require("../constants/cloudinary");

// Upload targets the client may ask for, by name. The client never sends a
// raw folder path — it sends one of these keys and the server resolves it.
// That way a caller cannot talk us into signing an upload into an arbitrary
// folder, or into overwriting an asset outside the upcell/ tree.
const UPLOAD_TARGETS = {
  product: (context) => productFolder(context),
  category: () => CLOUDINARY_FOLDERS.CATEGORIES,
  hero: () => CLOUDINARY_FOLDERS.MARKETING_HERO,
  ad: () => CLOUDINARY_FOLDERS.MARKETING_ADS,
  static: () => CLOUDINARY_FOLDERS.STATIC,
};

// Cloudinary treats a signature as valid for one hour. Nothing here needs a
// window that wide, and a shorter one limits how long a leaked signature is
// worth anything.
const SIGNATURE_TTL_SECONDS = 300;

async function createUploadSignature(req, res, next) {
  try {
    const { target, context = "", parts = [], sourceKey } = req.body || {};

    const resolveFolder = UPLOAD_TARGETS[target];
    if (!resolveFolder) {
      return res.status(400).json({
        error: "Invalid upload target",
        allowed: Object.keys(UPLOAD_TARGETS),
      });
    }

    if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) {
      return res.status(400).json({ error: "parts must be an array of strings" });
    }

    const folder = resolveFolder(context);

    // Belt and braces: the target map can only produce allowlisted folders,
    // but assert it anyway so a future edit to the map cannot silently widen
    // what this endpoint is willing to sign.
    if (!isAllowedFolder(folder)) {
      return res.status(400).json({ error: "Invalid upload target" });
    }

    const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = buildPublicId({ parts, sourceKey });

    // Only these three are signed, so only these three are enforced. Anything
    // else the browser adds to the upload form is rejected by Cloudinary,
    // because it would not match the signature.
    const signedParams = { folder, public_id: publicId, timestamp };
    const signature = buildUploadSignature(signedParams, apiSecret);

    return res.json({
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      expiresIn: SIGNATURE_TTL_SECONDS,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    });
  } catch (error) {
    // getCloudinaryConfig throws a 503 when keys are missing; let the shared
    // error handler render it rather than reporting it as a generic failure.
    return next(error);
  }
}

module.exports = { createUploadSignature, UPLOAD_TARGETS, SIGNATURE_TTL_SECONDS };
