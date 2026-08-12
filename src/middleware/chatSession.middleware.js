const crypto = require("crypto");
const ChatConversation = require("../models/chatConversation.model");

const COOKIE_NAME = "upcell_chat_sid";
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // idle expiry, refreshed every request

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    signed: true,
    maxAge: COOKIE_MAX_AGE_MS,
  };
}

// SEG F-01: the server decides who the caller is. The client may carry an
// identifier, but only one the server issued, signed, and can verify —
// req.body.sessionId is never read here or anywhere downstream.
//
// Guests get a signed HttpOnly cookie minted on first contact. Logged-in
// users are identified by req.user (set upstream by optionalAuth) — no
// separate chat id needed. If both are present, this is the guest-to-
// logged-in transition (SEG Section 04): rebind the guest transcript to the
// now-known user and stop honoring the old cookie so it can't be replayed
// afterward as a bearer token for someone else's support history.
async function resolveChatIdentity(req, res, next) {
  try {
    const options = cookieOptions();

    if (req.user?.id) {
      const guestId = req.signedCookies?.[COOKIE_NAME];
      if (guestId) {
        await ChatConversation.updateMany(
          { sessionId: guestId },
          { $set: { userId: req.user.id }, $unset: { sessionId: "" } }
        );
        res.clearCookie(COOKIE_NAME, {
          httpOnly: options.httpOnly,
          sameSite: options.sameSite,
          secure: options.secure,
        });
      }
      req.chatIdentity = { type: "user", id: req.user.id, key: `user:${req.user.id}` };
      return next();
    }

    let guestId = req.signedCookies?.[COOKIE_NAME];
    if (!guestId) {
      guestId = crypto.randomUUID();
    }
    res.cookie(COOKIE_NAME, guestId, options);
    req.chatIdentity = { type: "guest", id: guestId, key: `guest:${guestId}` };
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { resolveChatIdentity, COOKIE_NAME };
