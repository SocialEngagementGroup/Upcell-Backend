const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { optionalAuth, verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { resolveChatIdentity } = require("../middleware/chatSession.middleware");
const { chatLimiter, chatIdentityLimiter } = require("../middleware/rateLimit.middleware");
const { chatMessageSchema } = require("../schemas/request.schemas");
const { sendChatMessage } = require("../controllers/chat.controller");
const { getChatSettings, setKillSwitch } = require("../services/chat/chatSettingsService");

// optionalAuth populates req.user from a Bearer token when present, without
// requiring one — resolveChatIdentity then derives server-side identity
// from either req.user (logged in) or a signed guest cookie (SEG F-01).
// chatLimiter (IP, coarse) then chatIdentityLimiter (per resolved identity)
// are the first two of the four SEG §06 cost ceilings; the daily budget and
// kill switch are checked inside the controller before the Gemini call.
router.post(
  "/chat",
  optionalAuth,
  resolveChatIdentity,
  chatLimiter,
  chatIdentityLimiter,
  validateRequest(chatMessageSchema),
  sendChatMessage
);

// Admin-only kill switch (SEG §06) — flips without a deploy.
router.get("/chat/admin/settings", verifyToken, requireAdmin, async (req, res, next) => {
  try {
    const settings = await getChatSettings();
    res.json({ killSwitchEnabled: settings.killSwitchEnabled });
  } catch (error) {
    next(error);
  }
});

router.patch("/chat/admin/settings", verifyToken, requireAdmin, async (req, res, next) => {
  try {
    const settings = await setKillSwitch(Boolean(req.body.killSwitchEnabled));
    res.json({ killSwitchEnabled: settings.killSwitchEnabled });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
