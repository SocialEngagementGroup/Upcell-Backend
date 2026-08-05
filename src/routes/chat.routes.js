const router = require("express").Router();
const { validateRequest } = require("../middleware/validate.middleware");
const { chatLimiter } = require("../middleware/rateLimit.middleware");
const { chatMessageSchema } = require("../schemas/request.schemas");
const { sendChatMessage } = require("../controllers/chat.controller");

router.post("/chat", chatLimiter, validateRequest(chatMessageSchema), sendChatMessage);

module.exports = router;
