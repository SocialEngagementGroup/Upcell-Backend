const { slugify, parentSlug, variantSlug, ensureUniqueSlug } = require("../src/utils/slug");

// Slugs are URLs. Once a customer has one bookmarked or a search engine has
// indexed it, changing how these are built breaks that link — so the rules are
// pinned here rather than left to whatever the regex happens to do.
describe("slugify", () => {
  it("lowercases and joins words with single hyphens", () => {
    expect(slugify("iPhone Air")).toBe("iphone-air");
  });

  it("collapses runs of punctuation and spaces into one hyphen", () => {
    expect(slugify("MacBook Pro 14-inch  (M5 Pro)")).toBe("macbook-pro-14-inch-m5-pro");
  });

  // Anything outside a-z0-9 is replaced rather than escaped: a URL that needs
  // percent-encoding to be valid defeats the point of a readable one.
  it.each([
    ["Black & Slate", "black-slate"],
    ["Café Crème", "caf-cr-me"],
    ["  padded  ", "padded"],
    ["--already--hyphenated--", "already-hyphenated"],
  ])("turns %o into %o", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it.each([null, undefined, "", "!!!"])("returns an empty string for %o", (input) => {
    expect(slugify(input)).toBe("");
  });
});

describe("variantSlug — name, storage and colour", () => {
  it("builds the slug the product URL uses", () => {
    const slug = variantSlug({
      productName: "iPhone Air",
      storage: "256GB",
      color: { name: "Space Black" },
    });

    expect(slug).toBe("iphone-air-256gb-space-black");
  });

  // Real catalogue rows are missing one or another of these.
  it("skips the parts that are missing rather than leaving gaps", () => {
    expect(variantSlug({ productName: "iPad Air", storage: "64GB" })).toBe("ipad-air-64gb");
    expect(variantSlug({ productName: "iPad Air" })).toBe("ipad-air");
  });

  it("does not throw on an empty product", () => {
    expect(variantSlug()).toBe("");
    expect(variantSlug({})).toBe("");
  });
});

describe("parentSlug", () => {
  it("is just the family name", () => {
    expect(parentSlug("MacBook Air 15-inch (M3)")).toBe("macbook-air-15-inch-m3");
  });
});

describe("ensureUniqueSlug", () => {
  it("returns the slug untouched when it is free", async () => {
    const slug = await ensureUniqueSlug("iphone-air", async () => false);

    expect(slug).toBe("iphone-air");
  });

  it("appends a number when the slug is taken", async () => {
    const taken = new Set(["iphone-air", "iphone-air-2"]);
    const slug = await ensureUniqueSlug("iphone-air", async (candidate) => taken.has(candidate));

    expect(slug).toBe("iphone-air-3");
  });

  it("falls back to a usable name when there is nothing to slug", async () => {
    const slug = await ensureUniqueSlug("", async () => false);

    expect(slug).toBe("item");
  });

  // Bounded rather than while(true): a broken isTaken should fail the request,
  // not hang it.
  it("gives up rather than looping forever when everything is taken", async () => {
    await expect(ensureUniqueSlug("iphone-air", async () => true)).rejects.toThrow(/free slug/);
  });
});
