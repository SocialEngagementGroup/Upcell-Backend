// maxNetworkRetries is safe now that session create carries an
// idempotencyKey — a retried request lands on the same key instead of
// creating a second Stripe session.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || process.env.TEST_SECRET, {
  maxNetworkRetries: 2,
});
const Order = require("../models/order.model");
const { makeOrderObjAndTotal, hasPendingCheckout, logPaymentEvent } = require("./checkout.controller");

// Stripe requires product_data.images to be absolute URLs. Some product
// images are stored as relative paths served by the frontend's static
// assets, so resolve those against FRONTEND_URL before sending to Stripe.
const toAbsoluteImageUrl = (image) => {
  if (!image) return undefined;
  if (/^https?:\/\//i.test(image)) return image;
  return `${process.env.FRONTEND_URL}${image.startsWith("/") ? "" : "/"}${image}`;
};

exports.stripeCheckout = async (req, res, next) => {
  try {
    if (await hasPendingCheckout(req.body?.email)) {
      return res.status(409).json({
        error: "Checkout already in progress",
        message: "You already have a checkout in progress. Please complete it, or wait a few minutes and try again.",
      });
    }

    const { order, totalPrice } = await makeOrderObjAndTotal({
      req,
      paidWith: "Stripe",
    });

    // Create the order first so its ID is known before the Stripe session
    // is created, and can be embedded directly in success_url.
    const newOrder = await Order.create(order);

    const session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ["card"],
        line_items: order.line_items.map((item) => ({
          price_data: {
            currency: item.price_data.currency,
            unit_amount: item.price_data.unit_amount,
            product_data: {
              name: item.price_data.product_data.name,
              description: item.price_data.product_data.description,
              images: (item.price_data.product_data.images || [])
                .map(toAbsoluteImageUrl)
                .filter(Boolean),
            },
          },
          quantity: item.quantity,
        })),
        mode: "payment",
        success_url: `${process.env.FRONTEND_URL}/succeed?order_id=${newOrder._id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/cart`,
        customer_email: order.email,
        metadata: {
          orderId: newOrder._id.toString(),
        },
        // Also stamped on the resulting PaymentIntent/Charge (not just the
        // Checkout Session), so later events tied to the charge — refunds,
        // disputes — carry orderId directly instead of needing an extra
        // lookup back to the session.
        payment_intent_data: {
          metadata: {
            orderId: newOrder._id.toString(),
          },
        },
      },
      // Prefer the client-generated key (stable across retries of the same
      // checkout attempt — see orderSchema.idempotencyKey) so a retried
      // request lands on the original Stripe session. Falls back to an
      // order-scoped key for any caller that doesn't supply one.
      { idempotencyKey: req.body?.idempotencyKey || `checkout-${newOrder._id}` }
    );

    newOrder.stripeSessionId = session.id;
    await newOrder.save();

    res.json({ url: session.url });
  } catch (error) {
    next(error);
  }
};

exports.stripeWebhook = async (req, res, next) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || process.env.TEST_ENDPOINTSECRET
    );
  } catch (err) {
    logPaymentEvent({ gateway: "Stripe", eventType: "signature_rejected" });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logPaymentEvent({
    gateway: "Stripe",
    eventType: "webhook_received",
    metadata: { type: event.type, id: event.id },
  });

  // Handle the event
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata.orderId;

      // Atomic claim, same reasoning as updateOrderPaid in
      // checkout.controller.js: a redelivered/overlapping webhook call
      // shouldn't be able to race a concurrent one past a find-then-save
      // check and double-process the same order.
      const order = await Order.findOneAndUpdate(
        { _id: orderId, paid: false },
        { paid: true, status: "Processing" },
        { new: true }
      );
      if (order) {
        console.log(`Order ${orderId} marked as paid via Stripe.`);
        logPaymentEvent({
          gateway: "Stripe",
          eventType: "marked_paid",
          orderId: order._id,
          gatewayReference: session.id,
        });
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const orderId = charge.metadata?.orderId;

      if (orderId) {
        await Order.findOneAndUpdate({ _id: orderId }, { status: "Refunded" });
        console.log(`Order ${orderId} marked as refunded via Stripe.`);
        logPaymentEvent({ gateway: "Stripe", eventType: "refunded", orderId, gatewayReference: charge.id });
      }
    }
  } catch (error) {
    // next(error) instead of a direct res.status(500) — routes through the
    // global error handler so a broken webhook actually alerts the admin
    // rather than failing silently. Still a 5xx, so Stripe still retries.
    next(error);
    return;
  }

  res.json({ received: true });
};
