#!/usr/bin/env node
/**
 * Bulk-uploads the local image catalogue to Cloudinary.
 *
 *   node scripts/migrate-images-to-cloudinary.js [--dry-run] [--only=products|static|ads]
 *
 * Idempotent by design. public_ids come from the same buildPublicId() the
 * runtime signature endpoint uses, keyed on each file's stable source path, so
 * re-running overwrites in place rather than accumulating duplicates. A failed
 * or partial run can simply be repeated.
 *
 * Writes scripts/cloudinary-manifest.json mapping every local path to its
 * uploaded public_id — that mapping is what the frontend manifest is rebuilt
 * from once the upload is verified.
 *
 * Reads credentials from Backend/.env. Nothing is deleted, locally or remotely.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getCloudinaryConfig, buildUploadSignature } = require("../src/config/cloudinary");
const {
  CLOUDINARY_FOLDERS,
  productFolder,
  slugify,
  buildPublicId,
} = require("../src/constants/cloudinary");

const FRONTEND_PUBLIC = path.resolve(
  __dirname, "..", "..", "Frontend", "public"
);

const SOURCES = {
  products: { dir: "product-images", folder: null },   // folder resolved per file
  static: { dir: "staticImages", folder: CLOUDINARY_FOLDERS.STATIC },
  ads: { dir: "adds", folder: CLOUDINARY_FOLDERS.MARKETING_ADS },
};

const CONCURRENCY = 8;
const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)$/i;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1];

const walk = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  ))
  : []);

// Derives the readable slug from the file's location. For products the local
// filenames already encode family/model/colour (e.g.
// "ipad-ipad-air-ipad-air-11-13-m3-blue-<amazon-code>.jpg"), so tokens are
// de-duplicated to keep the id readable rather than repeating "ipad" three
// times. The trailing hash from buildPublicId guarantees uniqueness either way.
const deriveParts = (relPath) => {
  const base = path.basename(relPath).replace(IMAGE_RE, "");
  const tokens = slugify(base).split("-").filter(Boolean);

  const seen = new Set();
  const deduped = tokens.filter((t) => {
    if (seen.has(t) || /^\d{6,}$/.test(t)) return false;
    seen.add(t);
    return true;
  });

  return [deduped.slice(0, 8).join("-")];
};

const targetFor = (kind, relPath) => {
  if (kind !== "products") return SOURCES[kind].folder;
  return productFolder(relPath);
};

async function uploadOne({ absPath, relPath, folder, publicId, config }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedParams = { folder, overwrite: "true", public_id: publicId, timestamp };
  const signature = buildUploadSignature(signedParams, config.apiSecret);

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(absPath)]), path.basename(absPath));
  form.append("api_key", config.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("overwrite", "true");

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    { method: "POST", body: form }
  );

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

(async () => {
  const config = getCloudinaryConfig();
  console.log(`cloud: ${config.cloudName}${DRY_RUN ? "   [DRY RUN]" : ""}\n`);

  const jobs = [];
  for (const [kind, { dir }] of Object.entries(SOURCES)) {
    if (ONLY && ONLY !== kind) continue;

    const root = path.join(FRONTEND_PUBLIC, dir);
    for (const absPath of walk(root).filter((f) => IMAGE_RE.test(f))) {
      const relPath = path.relative(FRONTEND_PUBLIC, absPath).replace(/\\/g, "/");
      const folder = targetFor(kind, relPath);
      const publicId = buildPublicId({ parts: deriveParts(relPath), sourceKey: relPath });
      jobs.push({ kind, absPath, relPath, folder, publicId, config });
    }
  }

  console.log(`${jobs.length} images queued`);
  for (const kind of Object.keys(SOURCES)) {
    const n = jobs.filter((j) => j.kind === kind).length;
    if (n) console.log(`  ${kind.padEnd(9)} ${n}`);
  }
  console.log();

  // Guard against two different sources colliding on one id before spending
  // any upload calls on it.
  const ids = new Map();
  for (const j of jobs) {
    const full = `${j.folder}/${j.publicId}`;
    if (ids.has(full)) throw new Error(`id collision: ${full}\n  ${ids.get(full)}\n  ${j.relPath}`);
    ids.set(full, j.relPath);
  }
  console.log(`${ids.size} unique public_ids, no collisions\n`);

  if (DRY_RUN) {
    jobs.slice(0, 10).forEach((j) => console.log(`  ${j.relPath}\n    -> ${j.folder}/${j.publicId}`));
    console.log(`\n(dry run - nothing uploaded)`);
    return;
  }

  const mapping = {};
  const failures = [];
  let done = 0;

  const queue = [...jobs];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const result = await uploadOne(job);
        mapping[job.relPath] = {
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          format: result.format,
        };
      } catch (error) {
        failures.push({ relPath: job.relPath, error: error.message });
      }
      done++;
      if (done % 50 === 0 || done === jobs.length) {
        process.stdout.write(`  ${done}/${jobs.length} (${failures.length} failed)\n`);
      }
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const out = path.join(__dirname, "cloudinary-manifest.json");
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), mapping, failures }, null, 2));

  const uploadedBytes = Object.values(mapping).reduce((s, m) => s + (m.bytes || 0), 0);
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(`  uploaded: ${Object.keys(mapping).length}`);
  console.log(`  failed:   ${failures.length}`);
  console.log(`  bytes:    ${(uploadedBytes / 1048576).toFixed(1)} MB`);
  console.log(`  mapping:  ${path.relative(process.cwd(), out)}`);

  if (failures.length) {
    console.log("\nfirst failures:");
    failures.slice(0, 5).forEach((f) => console.log(`  ${f.relPath}: ${f.error}`));
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
