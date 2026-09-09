const { getCloudinaryConfig, buildUploadSignature } = require("../config/cloudinary");

// Deleting an asset from Cloudinary by its public_id.
//
// The Admin API rather than the upload API: destroying an asset is not
// something a browser is ever allowed to do, so this is signed the same way an
// upload is but only ever called from a scheduled job.
//
// Written as a small module rather than pulling in the cloudinary SDK for one
// call. The SDK is a large dependency whose main value is the upload path,
// which this project already does by signed direct-to-Cloudinary POST.

const DESTROY_URL = (cloudName) =>
  `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`;

/**
 * Deletes one asset.
 *
 * Cloudinary answers 200 with `{ result: "not found" }` for an id that is not
 * there, which is treated as success on purpose: a photo already gone is the
 * state the purge wanted, and failing on it would make the job retry forever
 * over a record that can never succeed.
 *
 * @returns {{ok: true, result: string} | {ok: false, error: string}}
 */
async function destroyAsset(publicId, { fetchImpl = fetch } = {}) {
  if (!publicId) return { ok: false, error: "No public id given." };

  let config;
  try {
    config = getCloudinaryConfig();
  } catch (error) {
    // Keys missing. Surfaced rather than swallowed: a purge that silently does
    // nothing looks identical to one that worked, and the photos stay.
    return { ok: false, error: error.message };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildUploadSignature({ public_id: publicId, timestamp }, config.apiSecret);

  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: config.apiKey,
    signature,
  });

  try {
    const response = await fetchImpl(DESTROY_URL(config.cloudName), { method: "POST", body });

    if (!response.ok) {
      return { ok: false, error: `Cloudinary answered ${response.status}` };
    }

    const payload = await response.json();

    // "ok" and "not found" both mean the asset is gone.
    if (payload?.result === "ok" || payload?.result === "not found") {
      return { ok: true, result: payload.result };
    }

    return { ok: false, error: payload?.result || "Cloudinary refused the delete" };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { destroyAsset };
