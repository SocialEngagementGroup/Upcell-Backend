const crypto = require("crypto");

const {
  CLOUDINARY_FOLDERS,
  ALLOWED_UPLOAD_FOLDERS,
  isAllowedFolder,
  resolveProductFamily,
  productFolder,
  slugify,
  buildPublicId,
} = require("../src/constants/cloudinary");

const { getCloudinaryConfig, buildUploadSignature } = require("../src/config/cloudinary");
const { createUploadSignature } = require("../src/controllers/upload.controller");

const makeReqRes = (body = {}) => {
  const req = { body };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return { req, res, next };
};

const withKeys = (fn) => async () => {
  const saved = {
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "123456789";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("cloudinary constants — folder tree", () => {
  it("keeps every folder under the single upcell/ root", () => {
    for (const folder of ALLOWED_UPLOAD_FOLDERS) {
      expect(folder.startsWith("upcell/")).toBe(true);
    }
  });

  it("allows the fixed folders", () => {
    expect(isAllowedFolder(CLOUDINARY_FOLDERS.CATEGORIES)).toBe(true);
    expect(isAllowedFolder("upcell/products/iphone")).toBe(true);
  });

  it("rejects anything outside the tree", () => {
    expect(isAllowedFolder("other-project/products")).toBe(false);
    expect(isAllowedFolder("upcell/../secrets")).toBe(false);
    expect(isAllowedFolder("upcell/products/iphone/extra")).toBe(false);
    expect(isAllowedFolder("")).toBe(false);
  });
});

describe("cloudinary constants — family resolution", () => {
  it.each([
    ["iPhone 16 Pro Max", "iphone"],
    ["iPad Air 11", "ipad"],
    ["MacBook Pro M3", "macbook"],
    ["Accessories", "accessory"],
  ])("maps %s to the %s folder", (input, expected) => {
    expect(resolveProductFamily(input)).toBe(expected);
  });

  // Unrecognised input must land in a known folder rather than creating a new
  // one, so the tree cannot grow sideways from admin free-text.
  it("falls back to 'other' for anything unrecognised", () => {
    expect(resolveProductFamily("Samsung Galaxy")).toBe("other");
    expect(resolveProductFamily("")).toBe("other");
    expect(resolveProductFamily(undefined)).toBe("other");
  });

  it("always produces an allowlisted product folder", () => {
    for (const input of ["iPhone", "weird input", "", null]) {
      expect(isAllowedFolder(productFolder(input))).toBe(true);
    }
  });
});

describe("cloudinary constants — slugify", () => {
  it.each([
    ["iPhone 16 Pro Max", "iphone-16-pro-max"],
    ["Black & Titanium", "black-and-titanium"],
    ["  spaced  out  ", "spaced-out"],
    ["Ünïcødé!!", "n-c-d"],
  ])("slugifies %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("never emits leading or trailing hyphens", () => {
    expect(slugify("---messy---")).toBe("messy");
  });

  it("caps length so a public_id cannot grow unbounded", () => {
    expect(slugify("a".repeat(200)).length).toBe(60);
  });
});

describe("cloudinary constants — buildPublicId", () => {
  it("produces slug--hash8", () => {
    const id = buildPublicId({ parts: ["iPhone 16 Pro", "Blue"], sourceKey: "src/a.jpg" });
    expect(id).toMatch(/^iphone-16-pro-blue--[0-9a-f]{8}$/);
  });

  // Idempotency is what stops a re-upload creating a near-duplicate asset:
  // same source in, same id out, so Cloudinary overwrites in place.
  it("is deterministic for the same source", () => {
    const args = { parts: ["iPad Air"], sourceKey: "src/b.jpg" };
    expect(buildPublicId(args)).toBe(buildPublicId(args));
  });

  it("disambiguates products that slugify identically", () => {
    const a = buildPublicId({ parts: ["Blue"], sourceKey: "one.jpg" });
    const b = buildPublicId({ parts: ["Blue"], sourceKey: "two.jpg" });
    expect(a).not.toBe(b);
    expect(a.split("--")[0]).toBe(b.split("--")[0]);
  });

  it("falls back to a usable id when parts are empty", () => {
    expect(buildPublicId({ parts: [], sourceKey: "x" })).toMatch(/^asset--[0-9a-f]{8}$/);
  });
});

describe("buildUploadSignature", () => {
  it("matches Cloudinary's documented scheme: sorted k=v joined by &, secret appended, sha1", () => {
    const params = { timestamp: 1700000000, folder: "upcell/categories", public_id: "x--abc12345" };
    const expected = crypto
      .createHash("sha1")
      .update("folder=upcell/categories&public_id=x--abc12345&timestamp=1700000000secret")
      .digest("hex");

    expect(buildUploadSignature(params, "secret")).toBe(expected);
  });

  it("sorts keys regardless of insertion order", () => {
    const a = buildUploadSignature({ b: 2, a: 1 }, "s");
    const b = buildUploadSignature({ a: 1, b: 2 }, "s");
    expect(a).toBe(b);
  });

  it("skips empty values so they do not corrupt the signed payload", () => {
    expect(buildUploadSignature({ a: 1, b: "" }, "s")).toBe(buildUploadSignature({ a: 1 }, "s"));
  });

  it("changes when the secret changes", () => {
    expect(buildUploadSignature({ a: 1 }, "s1")).not.toBe(buildUploadSignature({ a: 1 }, "s2"));
  });
});

describe("getCloudinaryConfig", () => {
  it("throws a 503 rather than a 500 when keys are missing", () => {
    const saved = process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_CLOUD_NAME;
    try {
      expect(() => getCloudinaryConfig()).toThrow(/not configured/i);
      try { getCloudinaryConfig(); } catch (error) { expect(error.status).toBe(503); }
    } finally {
      if (saved === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
      else process.env.CLOUDINARY_CLOUD_NAME = saved;
    }
  });

  it("treats a whitespace-only key as missing", () => {
    const saved = process.env.CLOUDINARY_API_KEY;
    process.env.CLOUDINARY_API_KEY = "   ";
    try {
      expect(() => getCloudinaryConfig()).toThrow(/CLOUDINARY_API_KEY/);
    } finally {
      if (saved === undefined) delete process.env.CLOUDINARY_API_KEY;
      else process.env.CLOUDINARY_API_KEY = saved;
    }
  });
});

describe("createUploadSignature", () => {
  it("signs a product upload into the resolved family folder", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "product", context: "iPhone 16 Pro", parts: ["iPhone 16 Pro", "Blue"] });
    await createUploadSignature(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.folder).toBe("upcell/products/iphone");
    expect(res.body.publicId).toMatch(/^iphone-16-pro-blue--[0-9a-f]{8}$/);
    expect(res.body.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(res.body.uploadUrl).toBe("https://api.cloudinary.com/v1_1/test-cloud/image/upload");
  }));

  it("returns a signature that verifies against the params it returned", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "category", parts: ["iPad"] });
    await createUploadSignature(req, res, jest.fn());

    const { folder, publicId, timestamp, signature } = res.body;
    expect(buildUploadSignature({ folder, public_id: publicId, timestamp }, "test-secret")).toBe(signature);
  }));

  // The API secret is the one value that must never leave the server.
  it("never returns the API secret", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "hero", parts: ["Homepage"] });
    await createUploadSignature(req, res, jest.fn());

    expect(JSON.stringify(res.body)).not.toContain("test-secret");
    expect(res.body.apiSecret).toBeUndefined();
  }));

  it.each([
    ["category", "upcell/categories"],
    ["hero", "upcell/marketing/hero"],
    ["ad", "upcell/marketing/ads"],
    ["static", "upcell/static"],
  ])("resolves the '%s' target to %s", withKeys(async (target, folder) => {
    const { req, res } = makeReqRes({ target, parts: ["x"] });
    await createUploadSignature(req, res, jest.fn());
    expect(res.body.folder).toBe(folder);
  }));

  it("rejects an unknown target", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "anything-else", parts: [] });
    await createUploadSignature(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.allowed).toContain("product");
  }));

  // The client sends a target name, never a path — so there is no folder
  // string for a caller to traverse out of in the first place.
  it("ignores a client-supplied folder path entirely", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "category", folder: "../../someone-else", parts: ["x"] });
    await createUploadSignature(req, res, jest.fn());

    expect(res.body.folder).toBe("upcell/categories");
  }));

  it("rejects a non-string parts array", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "product", parts: [{ evil: true }] });
    await createUploadSignature(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
  }));

  it("passes the 503 to next() when keys are missing, rather than throwing", async () => {
    const saved = process.env.CLOUDINARY_API_SECRET;
    delete process.env.CLOUDINARY_API_SECRET;
    try {
      const { req, res, next } = makeReqRes({ target: "category", parts: ["x"] });
      await createUploadSignature(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
    } finally {
      if (saved === undefined) delete process.env.CLOUDINARY_API_SECRET;
      else process.env.CLOUDINARY_API_SECRET = saved;
    }
  });

  it("issues a fresh timestamp per request", withKeys(async () => {
    const { req, res } = makeReqRes({ target: "category", parts: ["x"] });
    await createUploadSignature(req, res, jest.fn());

    expect(res.body.timestamp).toBeGreaterThan(1600000000);
    expect(res.body.expiresIn).toBe(300);
  }));
});
