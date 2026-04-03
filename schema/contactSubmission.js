const { Schema, model, models } = require("mongoose");

const contactSubmissionSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ["New", "Resolved"], default: "New" },
  },
  { timestamps: true }
);

contactSubmissionSchema.index({ status: 1, createdAt: -1 });
contactSubmissionSchema.index({ email: 1, createdAt: -1 });

const ContactSubmission = models?.ContactSubmission || model("ContactSubmission", contactSubmissionSchema);

module.exports = ContactSubmission;
