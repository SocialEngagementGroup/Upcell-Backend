const mongoose = require("mongoose");

// Single global document. killSwitchEnabled is SEG §06's "environment flag
// or database toggle that disables the widget with no deploy" — flipped via
// PATCH /chat/admin/settings (admin-only), read on every chat request.
const chatSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: "global",
  },
  killSwitchEnabled: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

const ChatSettings = mongoose.model("chat_settings", chatSettingsSchema);

module.exports = ChatSettings;
