const { z } = require("zod");

const numericField = z.preprocess((value) => {
  if (value === "" || value === null || typeof value === "undefined") return undefined;
  return Number(value);
}, z.number().nonnegative());

// `numericField.optional()` doesn't work as expected: Zod's optional-check
// only looks at the raw input, so an empty string ("" from a blank form
// field) still gets passed through the preprocess (which turns it into
// undefined) and then rejected by z.number(). Putting .optional() on the
// inner schema instead means preprocess's undefined output is accepted.
const optionalNumericField = z.preprocess((value) => {
  if (value === "" || value === null || typeof value === "undefined") return undefined;
  return Number(value);
}, z.number().nonnegative().optional());

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
  discountPrice: optionalNumericField,
  originalPrice: optionalNumericField,
  reviewScore: optionalNumericField,
  peopleReviewed: optionalNumericField,
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]),
  image: trimmedString("Image", 1, 20000000),
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
  discountPrice: optionalNumericField,
  originalPrice: optionalNumericField,
  outOfStock: z.boolean().optional().default(false),
});

const productBatchSchema = z.object({
  existingParentId: objectIdField.optional(),
  productName: trimmedString("Product name", 1, 140),
  categoryName: trimmedString("Category", 1, 140),
  categoryId: objectIdField.optional(),
  image: trimmedString("Image", 1, 20000000),
  images: z.array(z.object({ url: trimmedString("Image URL", 1, 20000000) })).optional(),
  reviewScore: optionalNumericField,
  peopleReviewed: optionalNumericField,
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]).default("Excellent"),
  variants: z.array(productVariantSchema).min(1, "At least one variant is required"),
});

const productCreateSchema = z.union([productSchema, productBatchSchema]);

// getFilteredProducts (POST /products/:n/:skip) builds a Mongo query
// straight from these fields with no prior type check — e.g. price[0]/[1]
// were indexed into without confirming price is even an array first, so a
// crafted object in place of an array/number could inject query operators.
// Public, unauthenticated endpoint, so this matters even though the
// frontend doesn't currently call it.
const productFilterSchema = z.object({
  productName: z.array(z.string()).default([]),
  storage: z.array(z.string()).default([]),
  color: z.array(z.string()).default([]),
  condition: z.array(z.string()).default([]),
  price: z
    .tuple([z.number().nonnegative(), z.number().nonnegative()])
    .default([0, Number.MAX_SAFE_INTEGER]),
});

// We ship to US addresses only (see Delivery Policy §2 "Shipping Destinations
// and Export"). The checkout form sends a fixed "United States", but the
// schema is the actual gate — it's shared by all three order-creation routes
// (currently POST /orders and /boa/prepare-payment), so a request crafted
// outside the form can't slip a foreign destination past it either. Accepts
// the handful of spellings a customer or an autofill might supply and
// normalises them, so downstream code and the admin view see one value.
const US_COUNTRY_FORMS = new Set([
  "us",
  "usa",
  "u.s.",
  "u.s.a.",
  "united states",
  "united states of america",
]);

const usOnlyCountryField = trimmedString("Country", 2, 120)
  .refine(
    (value) => US_COUNTRY_FORMS.has(value.toLowerCase().replace(/\s+/g, " ")),
    "We ship within the United States only."
  )
  .transform(() => "United States");

// 50 states, DC, and the US territories the postal service delivers to — the
// set the card networks accept for a US address.
const US_STATE_CODES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO " +
   "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
   "DC AS GU MP PR VI AA AE AP").split(" ")
);

const orderSchema = z.object({
  name: trimmedString("Name", 2, 120),
  email: emailField,
  phone: phoneField,
  city: trimmedString("City", 2, 120),
  // Two-letter US state code. The bank compares this against the card issuer's
  // records (AVS) and the profile is set to reverse the authorisation when that
  // check fails — so a missing or malformed state silently costs a sale.
  // Optional here because the manual-order path predates it and older clients
  // still post without it.
  // "FD" is two letters and passed the old length check, but it is not a state
  // — the issuer's address check fails and the sale is lost. Match against the
  // real list instead of just counting characters.
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => US_STATE_CODES.has(value), "Enter a valid 2-letter US state code")
    .optional(),
  // A real US ZIP, not "121" or "121212". The gateway rejects a malformed
  // postal code outright (reason code 102), and a valid-but-wrong one fails
  // the issuer's address check — either way the customer sees "payment failed"
  // with no clue that a typo in this box caused it. Catching it at the form is
  // the only place the customer can actually fix it.
  postal: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code, e.g. 94043"),
  street: trimmedString("Street", 5, 200),
  country: usOnlyCountryField,
  // The max matters as much as the min: this array is one entry per unit, it
  // reaches an unauthenticated-until-now endpoint, and it drives both a Mongo
  // $in and a per-id scan. Without a ceiling a single request could carry
  // hundreds of thousands of ids. 100 units is far above any real cart.
  orders: z
    .array(z.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(1, "At least one product is required")
    .max(100, "Too many items in one order"),
  shipping: z.enum(["standard", "priority", "express"]).default("standard"),
  paidWith: z.enum(["Card", "Manual", "BankOfAmerica"]).optional(),
  // Client-generated, once per checkout attempt — forwarded as the
  // PayPal-Request-Id / Stripe idempotencyKey on the outbound gateway call
  // so a retried request lands on the original transaction. Optional since
  // the Manual/"Contact to order" path doesn't call an external gateway.
  idempotencyKey: z.string().trim().max(100).optional(),
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

const wholesaleFormSchema = z.object({
  name: trimmedString("Name", 2, 120),
  email: emailField,
  phone: phoneField,
  devices: z.string().trim().max(500, "Devices must be 500 characters or fewer"),
});

const contactSubmissionSchema = z.object({
  name: trimmedString("Name", 2, 120),
  email: emailField,
  subject: trimmedString("Subject", 4, 180),
  message: trimmedString("Message", 10, 3000),
});

// A waived fee always carries a reason, enforced here rather than only in the
// controller — a request that fails validation never reaches business logic
// that could act on half-checked input.
const refundSchema = z
  .object({
    itemIds: z.array(objectIdField).max(50).optional(),
    waiveRestockingFee: z.boolean().optional().default(false),
    waiveReason: z.string().trim().max(500, "Reason must be 500 characters or fewer").optional(),
    notes: z.string().trim().max(1000, "Notes must be 1000 characters or fewer").optional(),
  })
  .refine((data) => !data.waiveRestockingFee || Boolean(data.waiveReason), {
    message: "A reason is required to waive the restocking fee.",
    path: ["waiveReason"],
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
  productFilterSchema,
  wholesaleFormSchema,
  tradeInRequestSchema,
  newsletterSubscriberSchema,
  contactSubmissionSchema,
  analyticsEventSchema,
  refundSchema,
};
