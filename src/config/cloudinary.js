const crypto = require("crypto");

const CLOUDINARY_ENV_VARS = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

// Deliberately NOT added to requiredEnvVars in config/env.js. That list is
// validated at boot and throws, so adding Cloudinary there would take the
// whole API down on any environment where the keys are not set yet — image
// uploads failing is recoverable, the server refusing to start is not.
// Missing keys surface here instead, as a 503 on the upload endpoint only.
function getCloudinaryConfig() {
  const missing = CLOUDINARY_ENV_VARS.filter(
    (name) => !process.env[name] || !process.env[name].trim()
  );

  if (missing.length > 0) {
    const error = new Error(
      `Image uploads are not configured. Missing: ${missing.join(", ")}`
    );
    error.status = 503;
    throw error;
  }

  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    apiKey: process.env.CLOUDINARY_API_KEY.trim(),
    apiSecret: process.env.CLOUDINARY_API_SECRET.trim(),
  };
}

// Cloudinary's signed-upload scheme: take every parameter the client will send
// except file, api_key and resource_type, sort by key, join as k=v pairs with
// &, append the API secret, then SHA-1 the result.
//
// Signing server-side is the whole point of this endpoint — it means the API
// secret never reaches the browser. The client receives a signature that is
// only valid for the exact folder, public_id and timestamp we approved.
function buildUploadSignature(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

module.exports = { CLOUDINARY_ENV_VARS, getCloudinaryConfig, buildUploadSignature };
