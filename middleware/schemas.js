const { z } = require("zod");

const numericField = z.preprocess((value) => {
  if (value === "" || value === null || typeof value === "undefined") return undefined;
  return Number(value);
}, z.number().nonnegative());

const objectIdField = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID");

const categorySchema = z.object({
  modelName: z.string().min(1, "Category name is required"),
  description: z.string().optional(),
  images: z.array(z.any()).optional().default([]),
});

const productSchema = z.object({
  parentCatagory: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Parent Category ID"),
  productName: z.string().min(1, "Product name is required"),
  description: z.string().optional(),
  storage: z.string().min(1, "Storage is required"),
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
  image: z.string().min(1, "Image is required"),
  categoryName: z.string().min(1, "Category is required").optional(),
  categoryId: objectIdField.optional(),
  outOfStock: z.boolean().optional(),
});

const productVariantSchema = z.object({
  storage: z.string().min(1, "Storage is required"),
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
  productName: z.string().min(1, "Product name is required"),
  categoryName: z.string().min(1, "Category is required"),
  categoryId: objectIdField.optional(),
  image: z.string().min(1, "Image is required"),
  images: z.array(z.object({ url: z.string().min(1, "Image URL is required") })).optional(),
  reviewScore: numericField.optional(),
  peopleReviewed: numericField.optional(),
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]).default("Excellent"),
  variants: z.array(productVariantSchema).min(1, "At least one variant is required"),
});

const productCreateSchema = z.union([productSchema, productBatchSchema]);

const orderSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(1, "Phone is required"),
  city: z.string().min(1, "City is required"),
  postal: z.string().min(1, "Postal code is required"),
  street: z.string().min(1, "Street is required"),
  country: z.string().min(1, "Country is required"),
  orders: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1, "At least one product is required"),
  shipping: z.enum(["standard", "priority", "express"]).default("standard"),
  paidWith: z.enum(["Stripe", "Paypal", "Card", "Manual"]).optional(),
});

const tradeInRequestSchema = z.object({
  device: z.string().min(1, "Device is required"),
  model: z.string().min(1, "Model is required"),
  modelTitle: z.string().min(1, "Model title is required"),
  carrier: z.string().optional(),
  carrierTitle: z.string().optional(),
  storage: z.string().min(1, "Storage is required"),
  estimate: numericField.refine((value) => value >= 0, "Estimate must be zero or more"),
  answers: z.record(z.string(), z.any()).optional().default({}),
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(1, "Phone is required"),
});

const newsletterSubscriberSchema = z.object({
  email: z.string().email("Invalid email address"),
  source: z.string().optional(),
});

const contactSubmissionSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  subject: z.string().min(1, "Subject is required"),
  message: z.string().min(1, "Message is required"),
});

module.exports = {
  categorySchema,
  productCreateSchema,
  productSchema,
  orderSchema,
  tradeInRequestSchema,
  newsletterSubscriberSchema,
  contactSubmissionSchema,
};
