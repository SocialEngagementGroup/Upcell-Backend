// Inspection photos: where they are written, and what can delete them.
//
// The delete guard is the reason this file exists. Inspection photos live in
// the same Cloudinary account as every product image on the site, and the
// purge job runs unattended. A bug that let it walk out of the returns tree
// would delete the catalogue's photos, and there are no originals to restore.

const {
  CLOUDINARY_FOLDERS,
  RETURNS_PREFIX,
  inspectionFolder,
  isReturnsAsset,
  isInspectionFolder,
  isAllowedFolder,
} = require("../src/constants/cloudinary");

const { buildUploadSignature } = require("../src/config/cloudinary");
const { createUploadSignature } = require("../src/controllers/upload.controller");
const { destroyAsset } = require("../src/services/cloudinaryDelete");
const { stampPurgeDates } = require("../src/services/returnInspection");
const { PHOTO_RETENTION_DAYS } = require("../src/constants/inspectionChecklist");

const makeReqRes = (body = {}) => {
  const req = { body };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { if (this.statusCode === null) this.statusCode = 200; this.body = payload; return this; },
  };
  return { req, res, next: jest.fn() };
};

const withKeys = (fn) => async () => {
  const saved = { ...process.env };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "123456789";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  try {
    await fn();
  } finally {
    process.env = saved;
  }
};

describe("upload", () => {
  it("uploads to the returns/inspections/{rmaNumber} folder", withKeys(async () => {
    const { req, res, next } = makeReqRes({
      target: "return_photo", context: "RMA-2026-00412", parts: ["Back glass"],
    });

    await createUploadSignature(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body.folder).toBe("upcell/returns/inspections/rma-2026-00412");
  }));

  it("gives each RMA its own folder", () => {
    // One return's photos in one place, so a purge is legible and a person
    // looking at the media library can see what a case holds.
    expect(inspectionFolder("RMA-2026-00412"))
      .not.toBe(inspectionFolder("RMA-2026-00413"));
  });

  it("never writes outside that folder prefix", withKeys(async () => {
    // The RMA arrives from the client. A caller who sends "../products" must
    // not be able to walk the upload out of the returns tree.
    for (const context of ["../../products", "..", "a/../../b", ""]) {
      const folder = inspectionFolder(context);

      expect(folder.startsWith(`${CLOUDINARY_FOLDERS.RETURNS_INSPECTIONS}/`)).toBe(true);
      expect(folder).not.toContain("..");

      const { req, res, next } = makeReqRes({ target: "return_photo", context, parts: ["x"] });
      await createUploadSignature(req, res, next);

      expect(res.body.folder.startsWith(RETURNS_PREFIX)).toBe(true);
    }
  }));

  it("refuses a folder that escapes the tree even if one were built by hand", () => {
    expect(isInspectionFolder("upcell/returns/inspections/../../products")).toBe(false);
    expect(isAllowedFolder("upcell/returns/inspections/../../products")).toBe(false);
  });

  it("allows a per-RMA subfolder that the fixed allowlist does not name", () => {
    // The RMA is part of the path, so the list cannot enumerate them.
    expect(isAllowedFolder("upcell/returns/inspections/rma-2026-00412")).toBe(true);
  });

  it("records publicId alongside url", () => {
    // Without the publicId a photo cannot be deleted, so the 90-day purge
    // would have nothing to act on.
    const [photo] = stampPurgeDates([
      { url: "https://cdn/a.jpg", publicId: "upcell/returns/inspections/rma-1/a" },
    ]);

    expect(photo.publicId).toBe("upcell/returns/inspections/rma-1/a");
    expect(photo.url).toBe("https://cdn/a.jpg");
  });

  it("sets purgeAfter to 90 days from upload", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const [photo] = stampPurgeDates([{ url: "u", publicId: "p" }], now);

    const days = (photo.purgeAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(PHOTO_RETENTION_DAYS);
    expect(days).toBe(90);
  });

  it("uses a signed upload, never an unsigned preset", withKeys(async () => {
    // An unsigned preset is a URL anybody can post to. These are photos of a
    // customer's device, in the account that holds every product image.
    const { req, res, next } = makeReqRes({
      target: "return_photo", context: "RMA-2026-00412", parts: ["Screen"],
    });

    await createUploadSignature(req, res, next);

    const { folder, publicId, timestamp, signature } = res.body;
    expect(signature).toMatch(/^[0-9a-f]{40}$/);
    expect(buildUploadSignature({ folder, public_id: publicId, timestamp }, "test-secret"))
      .toBe(signature);

    expect(JSON.stringify(res.body)).not.toMatch(/preset/i);
    expect(JSON.stringify(res.body)).not.toContain("test-secret");
  }));
});

describe("the delete guard", () => {
  const neverCalled = () => {
    const fetchImpl = jest.fn();
    return fetchImpl;
  };

  it("never targets a publicId outside the returns folder prefix", async () => {
    // The one that matters. Every id here is a real shape from this account.
    const outside = [
      "upcell/products/iphone/iphone-16-pro-blue--a1b2c3d4",
      "upcell/categories/ipad",
      "upcell/static/logo",
      "upcell/marketing/hero/homepage",
      "sample",
      "../upcell/returns/inspections/rma-1/a",
      "upcell/returns-not-really/a",
    ];

    for (const publicId of outside) {
      const fetchImpl = neverCalled();

      const result = await destroyAsset(publicId, { fetchImpl });

      expect(result.ok).toBe(false);
      expect(result.refused).toBe(true);
      expect(result.error).toMatch(/refusing to delete/i);
      // Not "it failed at Cloudinary" — the request is never made at all.
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("allows an id inside the returns tree", withKeys(async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true, json: async () => ({ result: "ok" }),
    }));

    const result = await destroyAsset("upcell/returns/inspections/rma-1/a", { fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  }));

  it("refuses an empty or missing id rather than deleting something", async () => {
    for (const publicId of ["", null, undefined]) {
      const fetchImpl = neverCalled();
      const result = await destroyAsset(publicId, { fetchImpl });

      expect(result.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("agrees with isReturnsAsset, which is the same test the purge reads", () => {
    expect(isReturnsAsset("upcell/returns/inspections/rma-1/a")).toBe(true);
    expect(isReturnsAsset("upcell/products/iphone/x")).toBe(false);
  });
});
