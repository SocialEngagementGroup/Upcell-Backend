// SEG Section 07 ("give it a real source"): the system prompt is not a
// knowledge base. This is the intended single canonical source for policy
// topics that both the website and the chatbot should read from — the
// external plan review flagged the risk of a separately-maintained FAQ
// drifting from the actual site content, so this stays deliberately empty
// (not a guessed copy) until each topic is client-approved.
//
// A topic staying `null` here is not a bug — it's what keeps the bot from
// stating something the site itself doesn't agree on yet (see the 30-day
// vs 14-day return-policy conflict in the compliance audit). Topics listed
// in TOPICS_REQUIRING_ESCALATION must be escalated by the controller
// whenever getApprovedContent() returns null for them.

const APPROVED_CONTENT = {
  // BLOCKED on client: ReturnPolicy.jsx says 30 days, TermsConditions.jsx
  // says 14 days. Do not fill this in until the client confirms which is
  // correct (Task #19) — filling it with a guess would recreate exactly
  // the "bot disagrees with the website" problem this file exists to avoid.
  returnPolicy: null,

  // BLOCKED on client: no promo terms exist anywhere on the site, and it's
  // not yet confirmed UpCell runs promotions at all (Task #20).
  promotions: null,

  // Safe to state today — confirmed directly from PrivacyPolicy.jsx.
  paymentSecurity:
    "Card payments are processed securely through our bank's merchant services — UpCell never sees or stores your full card number.",

  contactRoutes: {
    email: "usa.Upcells@gmail.com",
    supportPageUrl: "/support",
  },
};

const TOPICS_REQUIRING_ESCALATION = ["returnPolicy", "promotions"];

function getApprovedContent(topic) {
  return Object.prototype.hasOwnProperty.call(APPROVED_CONTENT, topic)
    ? APPROVED_CONTENT[topic]
    : null;
}

function isTopicApproved(topic) {
  return getApprovedContent(topic) !== null;
}

module.exports = { getApprovedContent, isTopicApproved, TOPICS_REQUIRING_ESCALATION };
