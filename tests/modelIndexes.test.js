// Index declarations are easy to get wrong in ways nothing else catches: a
// duplicate one only shows up as a startup warning, and a unique index on an
// array enforces something quite different from what it looks like it says.
// These assert the shape of the declarations themselves, so a regression is a
// failing test rather than a surprise the next time someone inserts a document.
const NewsletterSubscriber = require("../src/models/newsletterSubscriber.model");

// schema.indexes() returns only the explicitly declared ones. Field-level
// `unique: true` shows up on the path instead, which is exactly the difference
// the newsletter test below is about.
const declaredIndexes = (Model) => Model.schema.indexes();

describe("NewsletterSubscriber — email uniqueness is declared exactly once", () => {
  it("declares the unique email index explicitly, not also on the path", () => {
    const emailIndexes = declaredIndexes(NewsletterSubscriber)
      .filter(([fields]) => Object.keys(fields).join(",") === "email");

    expect(emailIndexes).toHaveLength(1);
    expect(emailIndexes[0][1]).toMatchObject({ unique: true });
  });

  it("does not repeat uniqueness on the path, which is what produced the startup warning", () => {
    expect(NewsletterSubscriber.schema.path("email").options.unique).toBeUndefined();
  });

  it("still requires and normalises the address", () => {
    const options = NewsletterSubscriber.schema.path("email").options;
    expect(options.required).toBe(true);
    expect(options.lowercase).toBe(true);
  });
});
