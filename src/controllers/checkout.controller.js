const Order = require("../models/order.model");
const SingleVariation = require("../models/singleVariation.model");
const PaymentEventLog = require("../models/paymentEventLog.model");
const { round2 } = require("../utils/money");
const { Resend } = require("resend");
const { paymentReceiptEmail, adminNewOrderEmail } = require("../services/emailTemplates");
const { EmailConfig } = require("../models/emailConfig.model");

// Reads the "Customer emails" switch from Admin > Email Settings. Defaults to
// sending if the row is missing or the lookup fails — a receipt is worth more
// to the customer than the switch is to us, and silently swallowing every
// receipt because of a database blip would be the worse failure.
const customerEmailsEnabled = async () => {
  try {
    const config = await EmailConfig.findOne().lean();
    return config ? config.enableCustomerEmails !== false : true;
  } catch (error) {
    console.error("[email-config] lookup failed, sending anyway:", error);
    return true;
  }
};

// Order.line_items keep a Stripe-style price_data shape. Stripe itself is
// long gone, but the stored orders still use that structure, so the shape
// stays — this flattens it to the {name, qty, price} rows the receipt email
// template expects.
exports.orderLineItemsForReceipt = (order) =>
  (order?.line_items || []).map((item) => ({
    name: item?.price_data?.product_data?.name || "Item",
    qty: item?.quantity || item?.price_data?.product_data?.metadata?.quantity || 1,
    price: item?.price_data?.product_data?.metadata?.totalPaid || 0,
  }));

// One definition of "what is this order worth". The receipt total and the
// check that the bank authorised the right figure must agree by construction —
// if they were computed separately, a drift between them would show up as a
// customer being charged one amount and emailed another.
exports.orderTotal = (order) =>
  round2(
    exports
      .orderLineItemsForReceipt(order)
      .reduce((sum, item) => sum + item.price, 0)
  );

// Called whenever an order is confirmed paid, alongside the customer
// receipt. Kept next to sendPaymentReceiptEmail deliberately: when these two
// lived apart, one gateway called the receipt and forgot this, and paid
// orders silently never reached the admin.
exports.sendAdminNewOrderEmail = (order) => {
  if (!adminNotificationEmail) return;

  const { subject, html } = adminNewOrderEmail({
    orderId: order._id,
    paidWith: order.paidWith,
    name: order.name,
    email: order.email,
  });

  resend.emails
    .send({ from: orderEmailFrom, to: [adminNotificationEmail], subject, html })
    .catch((error) => {
      console.error("Failed to send admin new-order email:", error);
    });
};

// Fire-and-forget on purpose — a failed receipt email must not fail the
// merchant-post response, since that response code is what tells the bank
// whether to retry the confirmation. Callers do not await it, so it must
// never reject: an unhandled rejection would take the process down rather
// than lose one email.
exports.sendPaymentReceiptEmail = async (order) => {
  try {
    if (!order?.email) return;

    // Honours the same "Customer emails" switch in Admin > Email Settings that
    // already gates trade-in mail. Previously only trade-in respected it, so
    // turning customer emails off still let payment receipts through — which
    // is the wrong behaviour when the switch is used to keep test orders from
    // reaching real inboxes.
    if (!(await customerEmailsEnabled())) return;

    const lineItems = exports.orderLineItemsForReceipt(order);
    const total = exports.orderTotal(order);
    const { subject, html } = paymentReceiptEmail({
      orderId: order._id,
      paidWith: order.paidWith,
      lineItems,
      total,
    });

    await resend.emails.send({
      from: orderEmailFrom,
      to: [order.email],
      subject,
      html,
    });
  } catch (error) {
    console.error("Failed to send payment receipt email:", error);
  }
};

// Fire-and-forget on purpose, same pattern as AuditLog.create() elsewhere —
// a logging failure must never block or fail the confirmation response, since
// that response code is what tells the bank whether to retry.
exports.logPaymentEvent = (fields) => {
  PaymentEventLog.create(fields).catch((error) => {
    console.error("[payment-event-log] failed to write:", error);
  });
};

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const orderEmailFrom = process.env.EMAIL_FROM;

// Sales tax rate charged at checkout. Defined once, here, because the customer
// is shown this figure before paying and the bank is sent the same figure — the
// two must never be able to drift apart.
//
// A single flat rate is a simplification: US sales tax varies by state, and some
// states charge none at all. Confirmed with the client as the rate to use for
// now; revisit if UpCell registers in more states.
const SALES_TAX_RATE = 0.08;

// A multi-tab customer (or a slow first request they retry) can otherwise
// create two separate, independently-payable orders for the same cart. These
// are genuinely two different orders rather than one retried, so no gateway
// idempotency key helps. Block a second attempt for the same email while an
// earlier one is still unpaid and recent.
//
// Deliberately short (not the 15min checkoutLimiter window). It only needs to
// cover the multi-tab race, which happens within seconds — a longer window
// would start blocking legitimate retries.
const PENDING_CHECKOUT_WINDOW_MS = 2 * 60 * 1000;

exports.hasPendingCheckout = async (email) => {
  const pending = await Order.findOne({
    email,
    paid: false,
    paidWith: "BankOfAmerica",
    // A confirmed decline is not a checkout in progress — the bank told us no
    // money moved, so the customer should be free to retry with another card
    // immediately rather than waiting out the window. Everything else that is
    // still unpaid stays blocked, including orders whose outcome we never
    // heard: not knowing whether money moved is exactly when to be cautious.
    status: { $ne: "payment failed" },
    createdAt: { $gte: new Date(Date.now() - PENDING_CHECKOUT_WINDOW_MS) },
  }).lean();
  return Boolean(pending);
};

// Builds the order document and its true total. Prices come from the
// database, never from the request — the client sends only product ids.
exports.makeOrderObjAndTotal = async ({ req, paidWith }) => {

  const {
    name,
    email,
    phone,
    city,
    state,
    postal,
    street,
    country,
    orders,
    shipping,
  } = req.body;

  const uniqueOrders = [...new Set(orders)];
  const productsInfo = await SingleVariation.find({ _id: { $in: uniqueOrders } });

  // Count each id once up front. The previous orders.filter() inside the loop
  // made this O(n²) on a caller-supplied array with no length cap.
  const quantities = orders.reduce(
    (counts, id) => counts.set(id, (counts.get(id) || 0) + 1),
    new Map()
  );

  const line_items = [];
  const unavailable = [];

  for (const id of uniqueOrders) {
    const info = productsInfo.find((p) => p._id.toString() === id);
    const quantity = quantities.get(id) || 0;

    if (quantity < 1) continue;

    // `productsInfo` is always an array, so the previous `quantity > 0 &&
    // productsInfo` guard was always true. A deleted or simply non-existent id
    // fell straight through with `info` undefined, and `info?.price * 100`
    // evaluated to NaN — which propagated into totalPrice and was handed to
    // the bank as amount="NaN".
    if (!info || !Number.isFinite(info.price)) {
      // `message` is not decoration — extractApiError on the frontend renders
      // `details` by mapping each entry to `item.message`, so an entry without
      // one reaches the customer as the literal text "undefined".
      unavailable.push({
        id,
        reason: "not_found",
        message: "An item in your cart is no longer listed.",
      });
      continue;
    }

    // outOfStock exists on the model but was only ever read for sorting and
    // display — nothing stopped a checkout for a unit already sold. These are
    // individual refurbished devices, so that is two customers paying for one
    // physical phone, and the second one has to be refunded by hand.
    if (info.outOfStock) {
      unavailable.push({
        id,
        reason: "out_of_stock",
        name: info.productName,
        message: `${info.productName || "An item"} has just sold out.`,
      });
      continue;
    }

    line_items.push({
      quantity,
      price_data: {
        currency: "USD",
        unit_amount: info.price * 100,
        product_data: {
          name: info.productName,
          description: `${info?.color?.name} ${info.condition} ${info.storage}`,
          images: [info.image],
          metadata: {
            productId: info._id,
            quantity,
            // Rounded here rather than left as a raw product — a device
            // price times a quantity can drift a fraction of a cent in
            // floating point (99.99 * 3 stores as 299.96999999999997), and
            // that drift is exactly how a reconciliation stops balancing.
            totalPaid: round2(info.price * quantity),
          },
        },
      },
    });
  }

  // Fail the whole checkout rather than quietly dropping the bad lines. Partial
  // fulfilment would charge the customer for a cart they never agreed to.
  if (unavailable.length) {
    const error = new Error(
      "Some items in your cart are no longer available. Please review your cart and try again."
    );
    error.status = 409;
    error.details = unavailable;
    throw error;
  }

  // Sales tax, charged on the goods only — not on shipping. This matches what
  // the cart and checkout have always displayed to the customer.
  //
  // Until now it was displayed and never charged: the website showed a total
  // including tax while the amount sent to the bank was goods plus shipping.
  // On a $2,398.84 order the card was charged $2,223.00, and UpCell absorbed
  // the $175.84 difference on every sale.
  //
  // Rounded to cents here rather than left as a float, so the figure the bank
  // receives is exactly the figure shown on screen. A cent of drift between
  // them would fail the amount check on the confirmation.
  const goodsTotal = line_items.reduce(
    (sum, item) => sum + (item?.price_data?.product_data?.metadata?.totalPaid || 0),
    0
  );
  const taxAmount = Math.round(goodsTotal * SALES_TAX_RATE * 100) / 100;

  if (taxAmount > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "USD",
        unit_amount: Math.round(taxAmount * 100),
        product_data: {
          name: "Sales tax",
          metadata: {
            totalPaid: taxAmount,
          },
        },
      },
    });
  }

  // adding price for shipping
  if (shipping === "priority") {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "USD",
        unit_amount: 10.5 * 100,
        product_data: {
          name: "Priority Shipping",
          metadata: {
            totalPaid: 10.5,
          },
        },
      },
    });
  } else if (shipping === "express") {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "USD",
        unit_amount: 25.0 * 100,
        product_data: {
          name: "Express Shipping",
          metadata: {
            totalPaid: 25.0,
          },
        },
      },
    });
  } else {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "USD",
        unit_amount: 0 * 100,
        product_data: {
          name: "Standard Shipping",
          metadata: {
            totalPaid: 0,
          },
        },
      },
    });
  }

  const order = {
    line_items,
    // Set by verifyToken on the authenticated checkout routes. Undefined on
    // the admin-created Manual path, which has no customer session.
    userId: req.user?.id,
    name,
    email,
    phone,
    city,
    state,
    postal,
    street,
    country,
    shipping,
    paid: false,
    status: "pending_payment",
    paidWith,
  };

  const totalPrice = round2(
    line_items.reduce(
      (total, currentObj) =>
        total + (currentObj?.price_data?.product_data?.metadata?.totalPaid ?? 0),
      0
    )
  );

  return { order, totalPrice };
};
