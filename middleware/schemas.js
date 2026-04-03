const { z } = require("zod");

const numericField = z.preprocess((value) => {
  if (value === "" || value === null || typeof value === "undefined") return undefined;
  return Number(value);
}, z.number().nonnegative());

const objectIdField = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID");
const trimmedString = (label, min = 1, max = 255) => z.string().trim().min(min, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);
const emailField = z.string().trim().email("Please enter a valid email address");
const phoneField = z.string().trim().min(7, "Please enter a valid phone number").max(20, "Please enter a valid phone number");

const categorySchema = z.object({
  modelName: trimmedString("Category name", 1, 120),
  description: z.string().trim().max(2000, "Description must be 2000 characters or fewer").optional(),
  images: z.array(z.any()).optional().default([]),
});

const productSchema = z.object({
  parentCatagory: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Parent Category ID"),
  productName: trimmedString("Product name", 1, 140),
  description: z.string().trim().max(2000, "Description must be 2000 characters or fewer").optional(),
  storage: trimmedString("Storage", 1, 40),
  color: z.object({
    name: z.string(),
    value: z.string().optional(),
    hex: z.string().optional(),
  }),
  price: numericField.refine((value) => value > 0, "Price must be positive"),
  discountPrice: numericField.optional(),
  originalPrice: numericField.optional(),
  reviewScore: numericField.optional(),
  peopleReviewed: numericField.optional(),
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]),
  image: trimmedString("Image", 1, 2000),
  categoryName: trimmedString("Category", 1, 140).optional(),
  categoryId: objectIdField.optional(),
  outOfStock: z.boolean().optional(),
});

const productVariantSchema = z.object({
  storage: trimmedString("Storage", 1, 40),
  color: z.object({
    name: z.string().min(1, "Color name is required"),
    value: z.string().optional(),
    hex: z.string().optional(),
  }),
  price: numericField.refine((value) => value > 0, "Price must be positive"),
  discountPrice: numericField.optional(),
  originalPrice: numericField.optional(),
  outOfStock: z.boolean().optional().default(false),
});

const productBatchSchema = z.object({
  existingParentId: objectIdField.optional(),
  productName: trimmedString("Product name", 1, 140),
  categoryName: trimmedString("Category", 1, 140),
  categoryId: objectIdField.optional(),
  image: trimmedString("Image", 1, 2000),
  images: z.array(z.object({ url: trimmedString("Image URL", 1, 2000) })).optional(),
  reviewScore: numericField.optional(),
  peopleReviewed: numericField.optional(),
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]).default("Excellent"),
  variants: z.array(productVariantSchema).min(1, "At least one variant is required"),
});

const productCreateSchema = z.union([productSchema, productBatchSchema]);

const orderSchema = z.object({
  name: trimmedString("Name", 2, 120),
  email: emailField,
  phone: phoneField,
  city: trimmedString("City", 2, 120),
  postal: trimmedString("Postal code", 3, 20),
  street: trimmedString("Street", 5, 200),
  country: trimmedString("Country", 2, 120),
  orders: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1, "At least one product is required"),
  shipping: z.enum(["standard", "priority", "express"]).default("standard"),
  paidWith: z.enum(["Stripe", "Paypal", "Card", "Manual"]).optional(),
});

const tradeInRequestSchema = z.object({
  device: trimmedString("Device", 1, 60),
  model: trimmedString("Model", 1, 120),
  modelTitle: trimmedString("Model title", 1, 160),
  carrier: z.string().trim().max(80, "Carrier must be 80 characters or fewer").optional(),
  carrierTitle: z.string().trim().max(120, "Carrier title must be 120 characters or fewer").optional(),
  storage: trimmedString("Storage", 1, 40),
  estimate: numericField.refine((value) => value >= 0, "Estimate must be zero or more"),
  answers: z.record(z.string(), z.any()).optional().default({}),
  name: trimmedString("Name", 2, 120),
  email: emailField,
  phone: phoneField,
});

const newsletterSubscriberSchema = z.object({
  email: emailField,
  source: z.string().trim().max(80, "Source must be 80 characters or fewer").optional(),
});

const contactSubmissionSchema = z.object({
  name: trimmedString("Name", 2, 120),
  email: emailField,
  subject: trimmedString("Subject", 4, 180),
  message: trimmedString("Message", 10, 3000),
});

const analyticsEventSchema = z.object({
  category: z.enum(["form_submit", "form_dropoff", "form_engagement", "admin_api_error"]),
  name: trimmedString("Event name", 1, 120),
  status: z.enum(["started", "success", "failed", "dropoff", "error"]).optional(),
  formName: z.string().trim().max(120, "Form name must be 120 characters or fewer").optional(),
  path: z.string().trim().max(500, "Path must be 500 characters or fewer").optional(),
  message: z.string().trim().max(1000, "Message must be 1000 characters or fewer").optional(),
  sessionId: z.string().trim().max(160, "Session ID must be 160 characters or fewer").optional(),
  metadata: z.record(z.string(), z.any()).optional().default({}),
});

module.exports = {
  categorySchema,
  productCreateSchema,
  productSchema,
  orderSchema,
  tradeInRequestSchema,
  newsletterSubscriberSchema,
  contactSubmissionSchema,
  analyticsEventSchema,
};
