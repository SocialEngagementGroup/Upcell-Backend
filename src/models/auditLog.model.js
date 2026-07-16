const { Schema, model, models } = require("mongoose");

const AuditLogSchema = new Schema(
  {
    actorId: { type: String, required: true },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ targetType: 1, targetId: 1 });

const AuditLog = models?.AuditLog || model("AuditLog", AuditLogSchema);

module.exports = AuditLog;
