function loadCorsOptions(env = {}) {
  jest.resetModules();
  delete process.env.FRONTEND_URL;
  delete process.env.FRONTEND_ORIGINS;
  delete process.env.FRONTEND_ORIGIN_PATTERNS;
  Object.assign(process.env, env);
  return require("../src/config/cors").corsOptions;
}

const callOrigin = (corsOptions, origin) =>
  new Promise((resolve) => {
    corsOptions.origin(origin, (err, allowed) => resolve({ err, allowed }));
  });

describe("corsOptions.origin", () => {
  it("allows the hardcoded default dev origin", async () => {
    const corsOptions = loadCorsOptions();
    const { err, allowed } = await callOrigin(corsOptions, "http://localhost:5173");
    expect(err).toBeNull();
    expect(allowed).toBe(true);
  });

  it("allows requests with no Origin header (server-to-server, curl, same-origin)", async () => {
    const corsOptions = loadCorsOptions();
    const { err, allowed } = await callOrigin(corsOptions, undefined);
    expect(err).toBeNull();
    expect(allowed).toBe(true);
  });

  it("allows an origin listed in FRONTEND_URL", async () => {
    const corsOptions = loadCorsOptions({ FRONTEND_URL: "https://upcell.example.com" });
    const { allowed } = await callOrigin(corsOptions, "https://upcell.example.com");
    expect(allowed).toBe(true);
  });

  it("allows a trailing slash in FRONTEND_URL to still match a slash-less origin", async () => {
    const corsOptions = loadCorsOptions({ FRONTEND_URL: "https://upcell.example.com/" });
    const { allowed } = await callOrigin(corsOptions, "https://upcell.example.com");
    expect(allowed).toBe(true);
  });

  it("allows multiple comma-separated origins via FRONTEND_ORIGINS", async () => {
    const corsOptions = loadCorsOptions({ FRONTEND_ORIGINS: "https://a.example.com, https://b.example.com" });
    expect((await callOrigin(corsOptions, "https://a.example.com")).allowed).toBe(true);
    expect((await callOrigin(corsOptions, "https://b.example.com")).allowed).toBe(true);
  });

  it("allows an origin matching a FRONTEND_ORIGIN_PATTERNS regex", async () => {
    const corsOptions = loadCorsOptions({ FRONTEND_ORIGIN_PATTERNS: "^https://.*\\.vercel\\.app$" });
    const { allowed } = await callOrigin(corsOptions, "https://upcell-preview-123.vercel.app");
    expect(allowed).toBe(true);
  });

  it("rejects an unlisted origin with a 403-tagged error (not a bare 500-defaulting error)", async () => {
    const corsOptions = loadCorsOptions();
    const { err, allowed } = await callOrigin(corsOptions, "https://attacker.example.com");

    expect(allowed).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
  });

  it("rejects an origin that merely resembles a whitelisted one (no accidental substring/prefix match)", async () => {
    const corsOptions = loadCorsOptions({ FRONTEND_URL: "https://upcell.example.com" });
    const { err } = await callOrigin(corsOptions, "https://upcell.example.com.attacker.net");
    expect(err.status).toBe(403);
  });
});
