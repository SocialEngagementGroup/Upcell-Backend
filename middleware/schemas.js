const { z } = require("zod");

const categorySchema = z.object({
  modelName: z.string().min(1, "Model name is required"),
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
    hex: z.string().optional(),
  }),
  price: z.number().positive("Price must be positive"),
  condition: z.enum(["Mint", "Excellent", "Good"]),
  image: z.string().url("Image must be a valid URL"),
});

const orderSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(1, "Phone is required"),
  city: z.string().min(1, "City is required"),
  postal: z.string().min(1, "Postal code is required"),
  street: z.string().min(1, "Street is required"),
  country: z.string().min(1, "Country is required"),
  orders: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1, "At least one product is required"),
  shipping: z.enum(["standard", "priority", "express"]),
});

module.exports = {
  categorySchema,
  productSchema,
  orderSchema,
};
