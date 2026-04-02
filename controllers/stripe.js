const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || process.env.TEST_SECRET);
const Order = require("../schema/order");
const { makeOrderObjAndTotal } = require("../checkout-customer/controllers/checkout");

exports.stripeCheckout = async (req, res, next) => {
  try {
    const { order, totalPrice } = await makeOrderObjAndTotal({
      req,
      paidWith: "Stripe",
    });

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: order.line_items.map((item) => ({
        price_data: {
          currency: item.price_data.currency,
          unit_amount: item.price_data.unit_amount,
          product_data: {
            name: item.price_data.product_data.name,
            description: item.price_data.product_data.description,
            images: item.price_data.product_data.images,
          },
        },
        quantity: item.quantity,
      })),
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/succeed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cart`,
      customer_email: order.email,
      metadata: {
        orderId: "", // Will be updated after order creation or handled in webhook
      },
    });

    // Save order with Stripe session ID
    order.stripeSessionId = session.id;
    const newOrder = await Order.create(order);
    
    // Update session metadata with database order ID
    await stripe.checkout.sessions.update(session.id, {
        metadata: { orderId: newOrder._id.toString() }
    });

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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.orderId;

    try {
      const order = await Order.findById(orderId);
      if (order && !order.paid) {
        order.paid = true;
        order.status = "Processing";
        await order.save();
        console.log(`Order ${orderId} marked as paid via Stripe.`);
      }
    } catch (error) {
      console.error("Error updating order from webhook:", error);
      return res.status(500).send("Internal Server Error");
    }
  }

  res.json({ received: true });
};
