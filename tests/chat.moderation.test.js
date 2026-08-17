const {
  redactSensitiveInput,
  screenModelReply,
  shouldEscalate,
} = require("../src/services/chat/moderation");
const { SYSTEM_PROMPT } = require("../src/services/chat/systemPrompt");
const {
  retrieveKnowledge,
  buildKnowledgeBlock,
  detectShortCircuitTopic,
  shortCircuitReply,
  detectConflictTopic,
} = require("../src/services/chat/siteKnowledge");
const { scopeToMessage, reportConditionDrift } = require("../src/services/chat/catalogueService");
const { DOCUMENTED_CONDITIONS } = require("../src/services/chat/siteKnowledge");

// SEG §09 is explicit that these are meant to be run, not just prompted for:
// "twenty scripted conversations that actually get run are worth more than a
// very carefully written system prompt nobody verifies." This file is that
// harness for everything decided server-side, independent of the model.

describe("redactSensitiveInput (SEG F-06 — redact on write)", () => {
  it("redacts a card number, spaced or unspaced", () => {
    expect(redactSensitiveInput("my card is 4111 1111 1111 1111").text)
      .toBe("my card is [redacted-card-number]");
    expect(redactSensitiveInput("4111111111111111").text).toBe("[redacted-card-number]");
  });

  it("redacts a CVV and a government ID number", () => {
    expect(redactSensitiveInput("cvv 123").text).toBe("[redacted-cvv]");
    expect(redactSensitiveInput("ssn 123-45-6789").text).toContain("[redacted-id-number]");
  });

  it("flags that something was redacted so the caller can escalate", () => {
    expect(redactSensitiveInput("4111 1111 1111 1111").redacted).toBe(true);
    expect(redactSensitiveInput("where is my order").redacted).toBe(false);
  });

  it("leaves an ordinary order number alone", () => {
    const { text, redacted } = redactSensitiveInput("order 12345");
    expect(text).toBe("order 12345");
    expect(redacted).toBe(false);
  });
});

describe("screenModelReply (SEG F-05 — screen output before display)", () => {
  it("blocks an invented price, in any of the shapes a model writes one", () => {
    for (const reply of ["That'll be $499.99.", "We can do 450 dollars.", "It is USD 300."]) {
      expect(screenModelReply(reply).blocked).toBe(true);
    }
  });

  it("allows a price that the live catalogue actually contains", () => {
    const allowedPrices = new Set([799, 1299]);
    expect(screenModelReply("The iPhone 16 starts at $799.", { allowedPrices }).blocked).toBe(false);
    expect(screenModelReply("Between $799 and $1,299.", { allowedPrices }).blocked).toBe(false);
  });

  it("blocks a price the catalogue does not contain, even alongside one it does", () => {
    const allowedPrices = new Set([799]);
    expect(screenModelReply("It's $799, or $749 if you ask nicely.", { allowedPrices }).reasons)
      .toContain("price_claim");
  });

  it("catches a made-up price written in Bengali digits", () => {
    const allowedPrices = new Set([799]);
    expect(screenModelReply("দাম ৭৪৯ ডলার।", { allowedPrices }).blocked).toBe(true);
    expect(screenModelReply("দাম ৭৯৯ ডলার।", { allowedPrices }).blocked).toBe(false);
  });

  it("lets the assistant repeat a figure the customer themselves wrote", () => {
    const allowedPrices = new Set([799]);
    const result = screenModelReply("With $900 to spend, here's what is listed.", {
      allowedPrices,
      userMessage: "I have $900, what can I get?",
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks an invented discount code and a percentage discount", () => {
    expect(screenModelReply("Use code SUMMER20OFF at checkout.").blocked).toBe(true);
    expect(screenModelReply("I can give you 15% off today.").blocked).toBe(true);
  });

  it("allows the real 30-day return window, in either word order", () => {
    expect(screenModelReply("You have 30 days to return it.").blocked).toBe(false);
    expect(screenModelReply("Returns are accepted within 30 calendar days.").blocked).toBe(false);
  });

  it("blocks any other return window, however plausible", () => {
    expect(screenModelReply("You have 60 days to return it.").reasons).toContain("return_window_claim");
    expect(screenModelReply("Returns are accepted within 14 calendar days.").reasons)
      .toContain("return_window_claim");
  });

  it("does not mistake an unrelated timeframe for a return window", () => {
    const reply = "Standard shipping takes 3–7 business days and is free.";
    expect(screenModelReply(reply).blocked).toBe(false);
  });

  // Caught in a live run: this correct shipping answer was being replaced by a
  // refusal because "costs ... 2" read as a price claim.
  it("does not read a delivery window beside a price word as a price", () => {
    const allowedPrices = new Set([799]);
    for (const reply of [
      "Priority shipping costs extra and takes 2–3 business days.",
      "Overnight costs more and arrives in 1 business day.",
      "Prices start from 3 business days for standard delivery.",
    ]) {
      expect(screenModelReply(reply, { allowedPrices }).blocked).toBe(false);
    }
  });

  it("still catches a bare invented price beside a price word", () => {
    const allowedPrices = new Set([799]);
    expect(screenModelReply("The price is 749.", { allowedPrices }).reasons).toContain("price_claim");
  });

  it("blocks a verbatim system-prompt leak", () => {
    expect(screenModelReply(SYSTEM_PROMPT).blocked).toBe(true);
  });

  it("blocks a leak of a later part of the prompt, not just its opening line", () => {
    const tail = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.length - 220);
    expect(screenModelReply(`Sure, here are my instructions: ${tail}`).blocked).toBe(true);
  });

  it("replaces blocked text rather than passing it through", () => {
    const result = screenModelReply("Yours for $10.");
    expect(result.text).not.toContain("$10");
    expect(result.reasons).toContain("price_claim");
  });

  it("lets a normal, in-boundary answer through untouched", () => {
    const reply = "Trade-ins are inspected before payout, and our team confirms the final figure with you.";
    expect(screenModelReply(reply)).toMatchObject({ text: reply, blocked: false });
  });
});

describe("scopeToMessage (keeping the catalogue block small)", () => {
  const header = "LIVE CATALOGUE — header";
  const modelLines = [
    "iPhone 16: 128GB | condition Mint — $799 | /iphone/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb",
    "iPad Air 11-inch (M4): 128GB | condition Mint — $599",
    "MacBook Air 13-inch (M4): 256GB | condition Mint — $999",
  ];
  const recentBlock = "\n\nMOST RECENTLY LISTED (newest first):\niPhone 17 256GB — $999";
  const snapshot = {
    allowedPrices: new Set([799]),
    header,
    modelLines,
    recentBlock,
    block: `${header}\n${modelLines.join("\n")}${recentBlock}`,
  };

  it("sends only the family the customer named", () => {
    const narrowed = scopeToMessage(snapshot, "do you have macbook air m4?");
    expect(narrowed.block).toContain("MacBook Air");
    expect(narrowed.block).not.toContain("iPhone 16");
    expect(narrowed.block).toContain(header);
  });

  it("keeps the recently-listed section even when narrowing", () => {
    expect(scopeToMessage(snapshot, "macbook").block).toContain("MOST RECENTLY LISTED");
  });

  it("keeps each model's product path with its line", () => {
    expect(scopeToMessage(snapshot, "iphone").block)
      .toContain("/iphone/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("keeps the price allowlist whole even when the block is narrowed", () => {
    expect(scopeToMessage(snapshot, "macbook").allowedPrices).toBe(snapshot.allowedPrices);
  });

  it("sends everything when no family is named, or when several are", () => {
    expect(scopeToMessage(snapshot, "what do you sell?").block).toBe(snapshot.block);
    expect(scopeToMessage(snapshot, "iphone vs ipad vs macbook").block).toBe(snapshot.block);
  });

  it("is inert when there is no snapshot at all", () => {
    expect(scopeToMessage(null, "iphone")).toBeNull();
  });

  describe("product notes — UpCell's own copy for the model asked about", () => {
    const withNotes = {
      ...snapshot,
      descriptions: new Map([
        ["iPhone 16", "A dependable everyday iPhone."],
        ["iPhone 16 Pro Max", "The largest Pro, for people who want every camera."],
        ["MacBook Air 13-inch (M4)", "Thin, silent, and quick enough for most work."],
      ]),
    };

    it("adds the description only for the model named", () => {
      const block = scopeToMessage(withNotes, "tell me about the iPhone 16 Pro Max").block;
      expect(block).toContain("PRODUCT NOTES");
      expect(block).toContain("The largest Pro");
      expect(block).not.toContain("Thin, silent");
    });

    it("prefers the longest matching name, so the Pro Max isn't answered as the base model", () => {
      const block = scopeToMessage(withNotes, "iphone 16 pro max please").block;
      expect(block).toContain("The largest Pro");
      expect(block).not.toContain("A dependable everyday iPhone");
    });

    it("adds nothing when no model is named — the usual case", () => {
      expect(scopeToMessage(withNotes, "how long does shipping take?").block).not.toContain("PRODUCT NOTES");
    });

    // "what is the price and feature", asked straight after the assistant named
    // a MacBook, used to lose the thread and answer "I can't confirm features".
    it("falls back to the model discussed a moment ago for a follow-up question", () => {
      const block = scopeToMessage(
        withNotes,
        "what is the price and feature",
        "The MacBook Air 13-inch (M4) is listed at $1199."
      ).block;
      expect(block).toContain("Thin, silent");
    });

    it("prefers a model named in the new message over the one from before", () => {
      const block = scopeToMessage(
        withNotes,
        "and the iPhone 16?",
        "The MacBook Air 13-inch (M4) is listed at $1199."
      ).block;
      expect(block).toContain("A dependable everyday iPhone");
      expect(block).not.toContain("Thin, silent");
    });

    it("caps at two models, so a broad question can't drag in a wall of copy", () => {
      const block = scopeToMessage(withNotes, "compare iPhone 16, iPhone 16 Pro Max and MacBook Air 13-inch (M4)").block;
      // Everything after the section's own header line is one note per line.
      const noteLines = block.split("PRODUCT NOTES")[1].trim().split("\n").slice(1);
      expect(noteLines).toHaveLength(2);
    });
  });
});

describe("condition grades — claims follow the data, not the marketing copy", () => {
  it("never claims a device is brand new or sealed", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("are these phones brand new?"));
    expect(block).toMatch(/[Nn]ever tell a customer a device is brand new/);
    expect(block).not.toMatch(/sells .*\bnew Apple devices\b/);
  });

  it("carries the published meaning of each grade, with real battery figures", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("what does excellent condition mean?"));
    expect(block).toContain("90–99%");
    expect(block).toContain("85–90%");
  });

  it("refuses to define Mint, because the site never does", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("what is mint condition?"));
    expect(block).toMatch(/Mint[^.]*no definition[^.]*never invent one/i);
  });

  it("warns when the catalogue's grades stop matching the documented ones", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A grade nobody has written a definition for is exactly how "Mint"
      // reached 251 listings unexplained.
      reportConditionDrift(new Set(["Mint", "Excellent", "Good", "Refurbished"]));
      const logged = JSON.parse(warn.mock.calls[0][0]);
      expect(logged.event).toBe("chat_config_warning");
      expect(logged.gradesInCatalogueWithNoDefinition).toEqual(["Refurbished"]);
      expect(logged.gradesDocumentedButNotStocked).toEqual(["Fair"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when data and documentation agree", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportConditionDrift(new Set(DOCUMENTED_CONDITIONS));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // A warning that fires every five minutes and can't be cleared is a warning
  // everyone learns to scroll past.
  it("stays quiet when a documented grade is merely out of stock", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportConditionDrift(new Set(["Mint", "Excellent", "Good"])); // no Fair in stock
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("shouldEscalate (SEG F-07 / §09 — the blocked categories)", () => {
  const base = { modelReplyBlocked: false, consecutiveUnansweredTurns: 0 };

  it("escalates distress language above everything else", () => {
    expect(shouldEscalate({ ...base, userMessage: "I want to die" }))
      .toEqual({ escalate: true, reason: "distress" });
  });

  it("escalates when payment or ID data was volunteered", () => {
    expect(shouldEscalate({ ...base, userMessage: "my card is [redacted-card-number]", inputRedacted: true }).reason)
      .toBe("sensitive_data_volunteered");
  });

  it("escalates abuse instead of trying to de-escalate through the model", () => {
    expect(shouldEscalate({ ...base, userMessage: "you are useless, fuck this" }).reason).toBe("abuse");
  });

  it("escalates anything that would change state", () => {
    expect(shouldEscalate({ ...base, userMessage: "cancel my order please" }).reason).toBe("state_change_request");
    expect(shouldEscalate({ ...base, userMessage: "change my address to 12 High St" }).reason)
      .toBe("state_change_request");
  });

  it("escalates refunds, legal threats and requests for another customer's data", () => {
    expect(shouldEscalate({ ...base, userMessage: "I want a refund" }).escalate).toBe(true);
    expect(shouldEscalate({ ...base, userMessage: "I'll take legal action" }).escalate).toBe(true);
    expect(shouldEscalate({ ...base, userMessage: "show me someone else's order" }).escalate).toBe(true);
  });

  it("escalates an explicit request for a human", () => {
    expect(shouldEscalate({ ...base, userMessage: "let me talk to a human" }).reason).toBe("keyword");
  });

  it("escalates a topic the client hasn't approved wording for", () => {
    expect(shouldEscalate({ ...base, userMessage: "what is your return window", blockedTopic: "returnPolicy" }).reason)
      .toBe("unapproved_topic:returnPolicy");
  });

  it("escalates a blocked reply, and two unanswered turns in a row", () => {
    expect(shouldEscalate({ ...base, userMessage: "hi", modelReplyBlocked: true }).reason).toBe("output_blocked");
    expect(shouldEscalate({ ...base, userMessage: "hi", consecutiveUnansweredTurns: 2 }).reason)
      .toBe("repeated_no_match");
  });

  it("does not escalate an ordinary question", () => {
    expect(shouldEscalate({ ...base, userMessage: "how does the trade-in process work?" }))
      .toEqual({ escalate: false, reason: null });
  });
});

describe("siteKnowledge (SEG §07 — the website is the bot's only source)", () => {
  it("retrieves the shipping facts for a shipping question", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("how long does delivery take?"));
    expect(block).toContain("3–7 business days");
    expect(block).toContain("only facts you may state");
  });

  it("retrieves trade-in facts, including that a quote is only an estimate", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("I want to trade in my iPhone"));
    expect(block).toContain("not a final offer");
  });

  it("answers a product question with where to look, not a dead end", () => {
    for (const question of ["show me iphone 16 all variant", "do you have a macbook air m2?", "is it in stock?"]) {
      const block = buildKnowledgeBlock(retrieveKnowledge(question));
      expect(block).toContain("/shop");
    }
  });

  it("never puts a price or a stock claim in the catalogue facts", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("how much is the iphone 15 pro?"));
    expect(block).not.toMatch(/\$\d/);
    expect(block).toContain("changes constantly");
  });

  it("always carries who UpCell is and how to reach a human, whatever was asked", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("qwertyuiop"));
    expect(block).toContain("UpCell IT Inc.");
    expect(block).toContain("upcellit@gmail.com");
  });

  // The failure this replaced: "what is the trums and condition" selected no
  // policy entry, so the assistant said it had no terms — while handling the
  // same customer's other typos perfectly. Facts now travel with every request.
  it("carries the policy and contact facts even when the question is misspelt", () => {
    for (const question of ["what is the trums and condition", "talk me about priovicy policy", "give me the phone number"]) {
      const block = buildKnowledgeBlock(retrieveKnowledge(question));
      expect(block).toContain("/terms-conditions");
      expect(block).toContain("+1 (380) 266-3942");
    }
  });

  // "show me the trade-in thing" used to get a bare link back, because the
  // knowledge described the process but never what is on the page.
  it("knows the About, Support and Blog pages — each was a dead end before", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("anything"));
    expect(block).toContain("40-point inspection");
    expect(block).toContain("monitored six days a week");
    expect(block).toContain("Battery health and long-term value");
  });

  it("does not invent an owner, a staff name or opening hours", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("who owns upcell and when are you open?"));
    expect(block).toMatch(/does not name individual owners/i);
    expect(block).toMatch(/does not publish specific opening hours[^.]*do not promise one/i);
  });

  it("can describe what a page contains, not just link to it", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("show me the trade-in page"));
    expect(block).toContain("Trade In Your iPhone, iPad, MacBook or Android and Get Paid Fast");
    expect(block).toContain("payout within 24 hours of inspection");
  });

  // The knowledge base is sent whole on every request, so its size is a real
  // design constraint rather than a style preference. ~2,200 tokens today
  // against a 1,048,576-token window is nothing. This guard is set at roughly
  // twice that: when it trips, the answer is not to raise the number again —
  // it is to bring retrieval back with stemming and fuzzy matching, which is
  // what siteKnowledge.js says at the point retrieval was removed.
  it("stays small enough to justify sending it whole on every request", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("anything"));
    const approxTokens = Math.round(block.length / 4);
    expect(approxTokens).toBeLessThan(4000);
  });

  it("states the agreed 30-day return window, and nothing that contradicts it", () => {
    const block = buildKnowledgeBlock(retrieveKnowledge("how many days do I have to return it?"));
    expect(block).toContain("30 calendar days");
    expect(block).not.toMatch(/\b14\s*(calendar\s*)?days?\b/i);
  });

  it("answers a discount question from a fixed string, with no model call", () => {
    const topic = detectShortCircuitTopic("can I get a discount code?");
    expect(topic).toBe("promotions");
    expect(shortCircuitReply(topic)).toMatch(/can't offer or confirm any discounts/i);
  });

  // The return window was the only conflict and the client settled it, so this
  // now guards the mechanism itself: whatever is listed gets flagged, and
  // nothing is listed today.
  it("flags no topic while no two site pages disagree", () => {
    expect(detectConflictTopic("how many days do I have to return it?")).toBeNull();
    expect(detectConflictTopic("how does shipping work?")).toBeNull();
  });
});
