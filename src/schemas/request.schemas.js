const { z } = require("zod");
const { RETURN_REASON_CODES } = require("../constants/returnReasons");
const {
  normalizeImei,
  normalizeSerial,
  isValidImei,
  isValidSerial,
} = require("../utils/deviceIdentity");

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

// Caps chosen well above what the real catalogue holds, so they bound an
// accident or an attack without ever refusing genuine data. Measured on
// 9 Sep 2026: the largest product family has 20 variants, the most images on a
// parent product is 6, and on a category 2.
const MAX_CATEGORY_IMAGES = 20;
const MAX_PRODUCT_IMAGES = 30;
const MAX_VARIANTS_PER_BATCH = 100;

const categorySchema = z.object({
  modelName: trimmedString("Category name", 1, 120),
  description: z.string().trim().max(2000, "Description must be 2000 characters or fewer").optional(),
  // Was z.array(z.any()) with no length limit — the only unbounded array on an
  // admin write route, and these routes carry a 25mb body allowance because
  // images are still posted as base64 data URLs.
  images: z
    .array(z.any())
    .max(MAX_CATEGORY_IMAGES, `A category can have at most ${MAX_CATEGORY_IMAGES} images`)
    .optional()
    .default([]),
});

const productSchema = z.object({
  parentCatagory: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Parent Category ID"),
  productName: trimmedString("Product name", 1, 140),
  description: z.string().trim().max(2000, "Description must be 2000 characters or fewer").optional(),
  storage: trimmedString("Storage", 1, 40),
  // Every other string in this schema is capped; these three were not, which
  // made them the one place an oversized value could reach the database on this
  // route. Admin-only, so not publicly reachable — but the cap costs nothing
  // and a colour is a short label and a hex code, never prose.
  color: z.object({
    name: trimmedString("Colour name", 1, 60),
    value: z.string().trim().max(40, "Colour value must be 40 characters or fewer").optional(),
    hex: z.string().trim().max(40, "Colour hex must be 40 characters or fewer").optional(),
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

// The identifiers of one physical device, typed by hand off a box or a
// settings screen. Validated rather than stored as given: an IMEI carries its
// own check digit, so a transposed pair can be caught at the keyboard instead
// of six months later when a returned phone cannot be matched to any order.
//
// An empty box means "not recorded", which is normal, so it becomes undefined
// rather than an empty string — a stored "" would collide with every other one
// under the unique index.
const imeiField = z
  .string()
  .trim()
  .transform((value) => normalizeImei(value))
  .refine(
    (value) => value === "" || isValidImei(value),
    "IMEI must be 15 digits and pass its check digit — check for a mistyped or swapped digit"
  )
  .transform((value) => value || undefined);

const serialField = z
  .string()
  .trim()
  .transform((value) => normalizeSerial(value))
  .refine(
    (value) => value === "" || isValidSerial(value),
    "Serial number must be 8 to 20 letters and digits"
  )
  .transform((value) => value || undefined);

const productVariantSchema = z.object({
  storage: trimmedString("Storage", 1, 40),
  imei: imeiField.optional(),
  serialNumber: serialField.optional(),
  color: z.object({
    name: z.string().min(1, "Color name is required"),
    value: z.string().optional(),
    hex: z.string().optional(),
  }),
  price: numericField.refine((value) => value > 0, "Price must be positive"),
  discountPrice: optionalNumericField,
  originalPrice: optionalNumericField,
  outOfStock: z.boolean().optional().default(false),
  // Which of the product's uploaded photos shows this exact variant. Carried
  // as the Cloudinary public_id rather than an index into the images array,
  // because an index silently points at a different photo the moment the admin
  // reorders or removes one.
  //
  // Optional: a product photographed once still works, and every variant falls
  // back to the first photo. Server-side the id is looked up in the product's
  // own images, so a caller cannot point a variant at an arbitrary asset.
  imagePublicId: trimmedString("Variant image", 1, 300).optional(),
});

const productBatchSchema = z.object({
  existingParentId: objectIdField.optional(),
  productName: trimmedString("Product name", 1, 140),
  categoryName: trimmedString("Category", 1, 140),
  categoryId: objectIdField.optional(),
  image: trimmedString("Image", 1, 20000000),
  // publicId matters as much as url does — it is what every delivery URL is
  // built from, so it is what lets one photo be served at a card's width and a
  // detail view's width. Validation replaces req.body wholesale, so a field
  // missing from this list is silently dropped before the controller ever sees
  // it; leaving publicId out defeated the upload it was added for.
  images: z
    .array(z.object({
      url: trimmedString("Image URL", 1, 20000000),
      publicId: trimmedString("Image public id", 1, 300).optional(),
      width: optionalNumericField,
      height: optionalNumericField,
    }))
    .max(MAX_PRODUCT_IMAGES, `A product can have at most ${MAX_PRODUCT_IMAGES} images`)
    .optional(),
  reviewScore: optionalNumericField,
  peopleReviewed: optionalNumericField,
  condition: z.enum(["Mint", "Excellent", "Good", "Fair", "Refubrished", "New"]).default("Excellent"),
  // Each variant becomes its own database document, so an unbounded array here
  // meant one request could create thousands of them — a pasted spreadsheet
  // does this by accident far more easily than an attacker does it on purpose.
  variants: z
    .array(productVariantSchema)
    .min(1, "At least one variant is required")
    .max(MAX_VARIANTS_PER_BATCH, `A product can have at most ${MAX_VARIANTS_PER_BATCH} variants`)
    // Storage and colour together are what a customer picks on the product
    // page, so two variants sharing both are not two things — they are one
    // thing saved twice. The page can only ever show one of them, which is how
    // a product came to claim three variants in the admin while offering two.
    //
    // Rejected here rather than de-duplicated silently, because the admin
    // needs to know which row to fix: the prices, stock and discounts of the
    // two rows can differ, and picking one for them would be a guess.
    .superRefine((variants, ctx) => {
      const seen = new Map();
      // One physical device cannot be two rows. Caught here as well as by the
      // unique index, because a pasted column of IMEIs is exactly where the
      // same number lands twice, and the form can say which two rows clash
      // where a database error cannot.
      const seenIdentifiers = new Map();

      variants.forEach((variant, index) => {
        const key = `${String(variant.storage || "").trim().toLowerCase()}|${String(variant.color?.name || "").trim().toLowerCase()}`;
        const first = seen.get(key);

        if (first === undefined) {
          seen.set(key, index);
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `Variants ${first + 1} and ${index + 1} are both ${variant.storage} in ${variant.color?.name}. Each storage and colour pair can only appear once.`,
          });
        }

        for (const [label, value] of [["IMEI", variant.imei], ["serial number", variant.serialNumber]]) {
          if (!value) continue;
          const at = `${label}:${value}`;
          const firstSeen = seenIdentifiers.get(at);

          if (firstSeen === undefined) {
            seenIdentifiers.set(at, index);
            continue;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `Variants ${firstSeen + 1} and ${index + 1} have the same ${label} (${value}). One device cannot be two units.`,
          });
        }
      });
    }),
});

const productCreateSchema = z.union([productSchema, productBatchSchema]);

// getFilteredProducts (POST /products/:n/:skip) builds a Mongo query
// straight from these fields with no prior type check — e.g. price[0]/[1]
// were indexed into without confirming price is even an array first, so a
// crafted object in place of an array/number could inject query operators.
// Public, unauthenticated endpoint, so this matters even though the
// frontend doesn't currently call it.
//
// The arrays also had no length limit, and each one is spread into a Mongo $in.
// This is the only public, unauthenticated route that builds a query from a
// caller-supplied array, so a single 2mb body could have become an $in with
// tens of thousands of terms. Bounded to well past anything the shop filters
// can produce — there are 83 product families and a handful of storages.
const filterTerms = (label) =>
  z
    .array(z.string().trim().max(140, `${label} values must be 140 characters or fewer`))
    .max(100, `At most 100 ${label} filters`)
    .default([]);

const productFilterSchema = z.object({
  productName: filterTerms("product name"),
  storage: filterTerms("storage"),
  color: filterTerms("colour"),
  condition: filterTerms("condition"),
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
// What a customer submits. reason is required and has a floor: "broken" tells
// staff nothing they can act on before the device has even been sent back.
// Where a returned device goes.
//
// The grade and a reason are demanded by services/returnDisposition.js
// depending on the route - a scrapped device needs a reason, and anything not
// going straight back on sale needs its grade, because that is what whoever
// handles it next has to know and it cannot be recovered once the device has
// left the bench.
const dispositionSchema = z.object({
  type: z.enum(["RELIST", "RELIST_REGRADED", "RETURN_TO_SUPPLIER", "WHOLESALE", "SCRAP"]),
  grade: z.enum(["EXCELLENT", "GOOD", "FAIR", "FAIL"]).optional(),
  // Required by services/returnDisposition.js when the grade dropped: the
  // system knows the device fell from Excellent to Good, but not what a Good
  // one of these is worth this month.
  price: optionalNumericField,
  reason: z.string().trim().max(500).optional(),
  // The only thing tying a device on a shelf to the return it came from.
  imei: z.string().trim().max(40).optional(),
});
// Recording that the customer has been paid.
//
// Nothing here moves money - it is the record that a person did. Which fields
// are required depends on the method, and services/returnSettlement.js enforces
// that: cash needs the signed receipt, a transfer needs the bank reference.
const settlementSchema = z.object({
  method: z.enum(["CASH", "BANK_TRANSFER", "ORIGINAL_PAYMENT"]).optional(),
  amount: numericField.refine((value) => value > 0, "Enter the amount that was paid"),
  reference: z.string().trim().max(120).optional(),
  // A photo of the signed receipt. Required for cash, where there is no bank
  // record behind the handover.
  receiptUrl: z.string().trim().url().optional(),
  notes: z.string().trim().max(1000).optional(),
});

// A revised refund offer.
//
// Amounts are staff judgement - how much a scuffed back is worth is not
// something a lookup table knows - but every deduction has to name the
// inspection check behind it, and services/revisedOffer.js refuses one that
// points at a check which passed. The offered total is never posted: it is
// computed from these.
const revisedOfferSchema = z.object({
  deductions: z
    .array(z.object({
      type: z.enum(["DAMAGE", "MISSING_ITEMS", "RESTOCKING_FEE", "INBOUND_POSTAGE"]),
      amount: numericField.refine((value) => value > 0, "A deduction has to be more than zero"),
      // What the customer reads. A number with no explanation is what gets
      // disputed and what UpCell then cannot defend.
      reason: z.string().trim().min(5, "Say why, in words the customer can read").max(500),
      findingKey: z.string().trim().max(60).optional(),
    }))
    .min(1, "A revised offer needs at least one deduction")
    .max(10),
  findings: z.string().trim().max(2000).optional(),
});

// The condition scale, read from the same constant the grading service uses
// so a new grade cannot exist in one place and not the other.
const RETURN_GRADES = Object.values(require("../constants/grading").GRADES);

// Moving the date a customer's return window started from.
//
// The note is required and has a minimum length on purpose: this decides
// whether a return is inside the window, so it moves money, and an override
// with "ok" in the box cannot be defended months later.
const windowOverrideSchema = z.object({
  startDate: z.coerce.date(),
  note: z.string().trim().min(10, "Say why you are changing this date").max(500),
});

// Freezing a return's photos past their ninety days, or letting them go.
//
// The reason is required when switching it on and cannot be switched on
// without one: a hold with no reason is a hold nobody can lift, because the
// next person has no way to tell whether the case closed.
const disputeHoldSchema = z.object({
  disputed: z.boolean(),
  reason: z.string().trim().max(500).optional(),
}).refine(
  (value) => !value.disputed || String(value.reason || "").trim().length >= 5,
  { path: ["reason"], message: "Say why this return is on hold" }
);

// Asking for a fresh link to a guest order.
//
// Both fields are required and neither is trusted: the id is checked for shape
// and the email is only ever compared against the one already on the order,
// never used to address the mail.
const orderLinkRequestSchema = z.object({
  orderId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, "Enter the order ID from your confirmation email"),
  email: emailField,
});

// Marking an order shipped.
//
// Deliberately loose on the tracking number, matching returnShipping.js: a
// strict pattern rejects a real number the moment a carrier changes theirs,
// which strands a real parcel to prevent a typo. The service applies the same
// rule; this is the outer guard.
const orderShipmentSchema = z.object({
  carrier: z.string().trim().min(1),
  trackingNumber: z.string().trim().min(1),
  labelUrl: z.string().trim().url().optional().or(z.literal("")),
});

// A completed inspection.
//
// Loose here on purpose: the real rules - every check answered, at least five
// photos, every photo carrying its Cloudinary id - live in
// services/returnInspection.js, so they can be tested without a request and
// reused by trade-in intake later. This is the outer shape guard.
const inspectionSubmitSchema = z.object({
  checklist: z
    .array(z.object({
      key: z.string().trim().min(1),
      result: z.enum(["pass", "fail", "na"]),
      note: z.string().trim().max(500).optional(),
      // Two checks answer with more than pass or fail, and both must be listed
      // here: validation replaces req.body wholesale, so a field this schema
      // does not name is stripped before the service ever sees it. Left out,
      // the battery reading and the cosmetic grade arrive as undefined and
      // every inspection is rejected for not having them.
      //
      // The battery percentage. Recorded, never a deduction.
      value: z.coerce.number().min(0).max(100).optional(),
      // The cosmetic grade. One of the two axes the final grade is the lower of.
      grade: z.enum(RETURN_GRADES).optional(),
    }))
    .min(1, "The checklist has not been filled in")
    .max(40),
  photos: z
    .array(z.object({
      url: z.string().trim().url(),
      // Without this a photo can never be deleted, so the 90-day purge would
      // silently leave it in the account forever.
      publicId: z.string().trim().min(1, "Every photo needs its Cloudinary id"),
      caption: z.string().trim().max(200).optional(),
      takenAt: z.coerce.date().optional(),
    }))
    .max(30, "That is more photos than an inspection needs"),
  findings: z.string().trim().max(2000).optional(),
  // Staff may override the computed grade; the checklist still decides the
  // suggested outcome. The same scale the catalogue uses — A/B/C was the old
  // internal one and no longer exists anywhere else.
  grade: z.enum(RETURN_GRADES).optional(),
  // Read off the device on the bench. The server compares it against what the
  // order says was sold rather than trusting the checklist tick, so the
  // "IMEI / serial matches the order" answer has something behind it.
  device: z
    .object({
      imei: imeiField.optional(),
      serial: serialField.optional(),
    })
    .optional(),
});

// Attaching a return label bought by hand in FedEx Ship Manager.
//
// Deliberately loose on the tracking number: carriers use different lengths and
// formats and change them, and a strict pattern rejects a real number the
// moment one of them does — which strands a real parcel to prevent a typo. The
// service applies the same rule; this is the outer guard.
const returnLabelSchema = z.object({
  carrier: z.enum(["FedEx", "UPS", "USPS", "DHL", "Other"]),
  trackingNumber: z
    .string()
    .trim()
    .min(6, "That tracking number looks too short")
    .max(40, "That tracking number looks too long"),
  // The printable label. https only — a label a customer cannot open is the
  // same as no label, and an http link is blocked in most mail clients anyway.
  labelUrl: z.string().trim().url().startsWith("https://", "The label link must be https").optional(),
  // What the label cost, so the postage UpCell absorbs can be reported on.
  labelCost: optionalNumericField,
});

const refundRequestCreateSchema = z
  .object({
    orderId: objectIdField,
    itemIds: z.array(objectIdField).min(1, "Choose at least one item to return").max(50),
    // Which of the listed reasons this is. It decides the return window, who
    // pays the postage and whether the 15% fee applies, so it is picked from a
    // list rather than typed. Optional while the old free-text form is still
    // in use; the new form always sends it.
    reasonCode: z.enum(RETURN_REASON_CODES).optional(),
    reason: z
      .string()
      .trim()
      .min(10, "Please describe the problem in a little more detail")
      .max(2000, "Reason must be 2000 characters or fewer"),
  })
  // OTHER is the code for "none of these fit", so it cannot stand on its own —
  // somebody has to read what actually happened before deciding who is at
  // fault. Every other code explains itself.
  .refine((data) => data.reasonCode !== "OTHER" || data.reason.trim().length >= 10, {
    message: "Please tell us what happened — we need the detail to sort this out.",
    path: ["reason"],
  });

// What staff send when moving a request along. Every field is optional here
// because which ones are required depends on the destination status — the
// controller enforces that, since only it knows where the request is coming
// from.
const refundRequestStatusSchema = z
  .object({
    status: z.enum(["ReturnApproved", "DeviceReceived", "Approved", "Refunded", "Rejected"]),
    returnInstructions: z.string().trim().max(4000).optional(),
    rejectionReason: z.string().trim().max(1000).optional(),
    inspectionNotes: z.string().trim().max(2000).optional(),
    waiveRestockingFee: z.boolean().optional().default(false),
    waiveReason: z.string().trim().max(500).optional(),
  })
  .refine((data) => !data.waiveRestockingFee || Boolean(data.waiveReason), {
    message: "A reason is required to waive the restocking fee.",
    path: ["waiveReason"],
  });

const refundSchema = z
  .object({
    itemIds: z.array(objectIdField).max(50).optional(),
    // Why the order is being refunded. Decides whether the 15% restocking fee
    // applies - see src/constants/returnReasons.js. Optional, and omitting it
    // charges no fee, which is the safe direction for a figure that cannot be
    // taken back once it has been paid.
    reasonCode: z.enum(RETURN_REASON_CODES).optional(),
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

// ids went straight into SingleVariation.find({ _id: { $in: ids || [] } })
// with no shape check. A Mongo operator object can't smuggle itself in
// through an array element of $in, so this was never truly exploitable — but
// a non-array ids (an object, a bare string) throws a CastError with no
// .status, which the global handler turns into a 500 and pages the admin
// over what is really just a malformed request.
const cartLookupSchema = z.object({
  ids: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid product id")).default([]),
});

// name was being read straight into a Mongo filter (MonthlySell.findOne({
// name })) with no shape check — a non-string value (an object such as
// {"$ne": null}) would be interpreted as a query operator rather than a
// literal to match. Admin-only, so not attacker-reachable from outside, but
// a real injection pattern regardless of who can trigger it.
const monthlySellSchema = z.object({
  name: trimmedString("Name", 1, 60),
  amount: z.number().finite("Amount must be a number"),
});

module.exports = {
  US_STATE_CODES,
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
  refundRequestCreateSchema,
  refundRequestStatusSchema,
  returnLabelSchema,
  inspectionSubmitSchema,
  windowOverrideSchema,
  orderShipmentSchema,
  orderLinkRequestSchema,
  disputeHoldSchema,
  revisedOfferSchema,
  settlementSchema,
  dispositionSchema,
  monthlySellSchema,
  cartLookupSchema,
};
