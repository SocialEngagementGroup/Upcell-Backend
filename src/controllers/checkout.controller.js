const { default: axios } = require("axios");
const { randomUUID } = require("crypto");
const Order = require("../models/order.model");
const SingleVariation = require("../models/singleVariation.model");
const PaymentEventLog = require("../models/paymentEventLog.model");
const { Resend } = require("resend");

// Fire-and-forget on purpose, same pattern as AuditLog.create() calls
// elsewhere — a logging failure must never block or fail the actual webhook
// response (that response code is what tells Stripe/PayPal whether to retry).
exports.logPaymentEvent = (fields) => {
  PaymentEventLog.create(fields).catch((error) => {
    console.error("[payment-event-log] failed to write:", error);
  });
};

// PayPal's client-credentials token is valid for ~9 hours (response.expires_in,
// in seconds) — cache it in memory instead of fetching a fresh one on every
// checkout/capture request, which was adding an extra OAuth round-trip to
// every payment action.
let cachedPaypalToken = { token: null, expiresAt: 0 };

// Outbound calls to PayPal shouldn't hang indefinitely if their API is slow —
// fail fast so the customer sees an error instead of an endless spinner.
const PAYPAL_REQUEST_TIMEOUT_MS = 15000;

const resend = new Resend(process.env.RESEND_KEY);
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
const orderEmailFrom = process.env.EMAIL_FROM;

const endpoint_url =
  process.env.ENVIRONMENT === "PRODUCTION"
    ? process.env.PAYPAL_BASE_URL
    : process.env.TEST_PAYPAL_BASE_URL;

const clientID =
  process.env.ENVIRONMENT === "PRODUCTION"
    ? process.env.PAYPAL_CLIENT_ID
    : process.env.TEST_PAYPAL_CLIENT_ID;

const clientSecret =
  process.env.ENVIRONMENT === "PRODUCTION"
    ? process.env.PAYPAL_SECRET
    : process.env.TEST_PAYPAL_SECRET;

const paypalWebhookId =
  process.env.ENVIRONMENT === "PRODUCTION"
    ? process.env.PAYPAL_WEBHOOK_ID
    : process.env.TEST_PAYPAL_WEBHOOK_ID;

// A multi-tab customer (or a slow first request they retry) can otherwise
// create two separate, independently-payable orders for the same cart —
// PayPal/Stripe idempotency doesn't help here since these are genuinely two
// different orders, not a retry of one. Block a second checkout attempt for
// the same email while an earlier one is still unpaid and recent.
//
// Deliberately short (not the 15min checkoutLimiter window): an order also
// sits at paid:false after a genuinely declined card, and we can't yet tell
// "declined, wants to retry with a different card" apart from "still being
// paid in another tab" from status alone (no webhook coverage for declines
// yet). A short window catches the multi-tab race, which happens within
// seconds, without also blocking a normal decline-and-retry for minutes.
const PENDING_CHECKOUT_WINDOW_MS = 2 * 60 * 1000;

exports.hasPendingCheckout = async (email) => {
  const pending = await Order.findOne({
    email,
    paid: false,
    paidWith: { $in: ["Stripe", "Paypal"] },
    createdAt: { $gte: new Date(Date.now() - PENDING_CHECKOUT_WINDOW_MS) },
  }).lean();
  return Boolean(pending);
};

exports.paypalCheckout = async (req, res, next) => {
  try {
    if (await exports.hasPendingCheckout(req.body?.email)) {
      return res.status(409).json({
        error: "Checkout already in progress",
        message: "You already have a checkout in progress. Please complete it, or wait a few minutes and try again.",
      });
    }

    const { order, totalPrice } = await exports.makeOrderObjAndTotal({
      req,
      paidWith: "Paypal",
    });

    const paypalOrder = await exports.createPaypalOrder(totalPrice, req.body?.idempotencyKey);

    const paypalId = paypalOrder?.id;

    if (paypalId) {
      order.paypalId = paypalId;

      await Order.create(order);

      res.json(paypalOrder);
    } else {
      return res.status(400).send("paypal error getting order id");
    }
  } catch (error) {
    next(error);
  }
};

// PayPal supports the same idempotency mechanism Stripe does, via a
// PayPal-Request-Id header: retrying a create/capture call with the same id
// returns the original result instead of creating a duplicate. Wraps fetch
// with a timeout so a slow PayPal response fails fast instead of hanging.
const paypalFetch = (url, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAYPAL_REQUEST_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
};

// use the orders api to create an order
exports.createPaypalOrder = async (totalprice, idempotencyKey) => {
  // create accessToken using your clientID and clientSecret
  // for the full stack example, please see the Standard Integration guide
  // https://developer.paypal.com/docs/multiparty/checkout/standard/integrate/
  const access_token = await exports.generatePaypalAccessToken();

  return paypalFetch(endpoint_url + "/v2/checkout/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
      // Client-provided key reused across retries when available (see
      // orderSchema.idempotencyKey) so a retried request lands on the same
      // PayPal order instead of creating a second one. Falls back to a
      // fresh id for any caller that doesn't supply one.
      "PayPal-Request-Id": idempotencyKey || randomUUID(),
    },
    body: JSON.stringify({
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: "" + totalprice,
          },
          reference_id: "d9f80740-38f0-11e8-b467-0ed5f89f718b",
        },
      ],
      intent: "CAPTURE",
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
            payment_method_selected: "PAYPAL",
            brand_name: "EXAMPLE INC",
            locale: "en-US",
            landing_page: "LOGIN",
            shipping_preference: "GET_FROM_FILE",
            user_action: "PAY_NOW",
            return_url: process.env.PAYPAL_RETURN_URL || "https://example.com/returnUrl",
            cancel_url: process.env.PAYPAL_CANCEL_URL || "https://example.com/cancelUrl",
          },
        },
      },
    }),
  }).then((response) => response.json());
};

exports.generatePaypalAccessToken = async () => {
  if (cachedPaypalToken.token && Date.now() < cachedPaypalToken.expiresAt) {
    return cachedPaypalToken.token;
  }

  const response = await axios({
    url: endpoint_url + "/v1/oauth2/token",
    method: "post",
    data: "grant_type=client_credentials",
    auth: {
      username: clientID,
      password: clientSecret,
    },
    timeout: PAYPAL_REQUEST_TIMEOUT_MS,
  });

  const { access_token, expires_in } = response?.data || {};

  // Refresh 60s before actual expiry so a near-expiry token is never handed
  // out and used just as PayPal invalidates it.
  cachedPaypalToken = {
    token: access_token,
    expiresAt: Date.now() + Math.max((expires_in || 0) - 60, 0) * 1000,
  };

  return access_token;
};

exports.capturePayment = async (req, res, next) => {
  try {
    const orderId = req.body?.orderID;

    const accessToken = await exports.generatePaypalAccessToken();

    const url = `${endpoint_url}/v2/checkout/orders/${orderId}/capture`;

    const response = await paypalFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "PayPal-Request-Id": randomUUID(),
        // Uncomment one of these to force an error for negative testing (in sandbox mode only). Documentation:
        // https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
        // "PayPal-Mock-Response": '{"mock_application_codes": "INSTRUMENT_DECLINED"}'
        // "PayPal-Mock-Response": '{"mock_application_codes": "TRANSACTION_REFUSED"}'
        // "PayPal-Mock-Response": '{"mock_application_codes": "INTERNAL_SERVER_ERROR"}'
      },
    });

    const responseData = await response.json();

    // console.log("capture  payment response : *** ", responseData);

    // update order status to paid
    let dbOrderId;
    if (responseData?.status === "COMPLETED") {
      const order = await exports.updateOrderPaid(responseData.id);
      dbOrderId = order?._id;
    } else if (responseData?.details?.some((detail) => detail.issue === "ORDER_ALREADY_CAPTURED")) {
      // A retried capture (network retry, double-click) landed on an order
      // PayPal already captured on an earlier attempt. The payment did
      // succeed — surface it as success instead of a false failure that
      // would otherwise invite the customer to pay a second time. Goes
      // through updateOrderPaid (not a raw lookup) so this is also the
      // self-healing path if the original call got COMPLETED from PayPal
      // but crashed before it could mark the order paid itself.
      const order = await exports.updateOrderPaid(orderId);
      dbOrderId = order?._id;
      return res.json({ status: "COMPLETED", orderId: dbOrderId });
    }

    return res.json({ ...responseData, orderId: dbOrderId });
  } catch (error) {
    next(error);
  }
};

// **********************************************
// we already designed order Schema accroding to stripe and used in different places in UI,

// that's why designing order data like this way with line items
exports.makeOrderObjAndTotal = async ({ req, paidWith }) => {

  const {
    name,
    email,
    phone,
    city,
    postal,
    street,
    country,
    orders,
    shipping,
  } = req.body;

  const uniqueOrders = [...new Set(orders)];
  const productsInfo = await SingleVariation.find({ _id: uniqueOrders });

  let line_items = [];

  for (const id of uniqueOrders) {
    const info = productsInfo.find((p) => p._id.toString() === id);
    const quantity = orders.filter((i) => i === id)?.length || 0;

    if (quantity > 0 && productsInfo) {
      line_items.push({
        quantity,
        price_data: {
          currency: "USD",
          unit_amount: info?.price * 100,
          product_data: {
            name: info?.productName,
            description: `${info?.color?.name} ${info?.condition} ${info?.storage}`,
            images: [info?.image],
            metadata: {
              productId: info?._id,
              quantity,
              totalPaid: info?.price * quantity,
            },
          },
        },
      });
    }
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
    name,
    email,
    phone,
    city,
    postal,
    street,
    country,
    shipping,
    paid: false,
    status: "payment failed",
    paidWith,
  };

  const totalPrice = line_items.reduce(
    (total, currentObj) =>
      total + (currentObj?.price_data?.product_data?.metadata?.totalPaid ?? 0),
    0
  );

  return { order, totalPrice };
};

// Three independent callers can reach this for the same order (the
// synchronous capture response, the PayPal webhook, and a retried capture
// that lands on ORDER_ALREADY_CAPTURED) — findOne-then-save would let two of
// them race past the `!order.paid` check at once and double-send the admin
// email. findOneAndUpdate's filter makes the "claim" atomic: only the
// caller that actually flips paid:false -> true gets a non-null result.
exports.updateOrderPaid = async (paypalId) => {
  const updatedOrder = await Order.findOneAndUpdate(
    { paypalId, paid: false },
    { paid: true, status: "Processing" },
    { new: true }
  );

  if (updatedOrder) {
    // sending emails to globaltradersww2@gmail.com to confirm order
    await resend.emails.send({
      from: orderEmailFrom,
      to: [adminNotificationEmail],
      subject: "New order on Global Traders",
      html: `<strong>New Orders!</strong> </br> <p>Order Id:  ${updatedOrder._id}</p> </br> <h2>Go to Global Traders Admin page to see all orders</h2> </br> Link: https://globaltraders-usa.com/admin-secret/orders`,
    });
    return updatedOrder;
  }

  // Already paid by another caller, or no matching order — return current
  // state (possibly null) without re-notifying.
  return Order.findOne({ paypalId });
};

// Verifies that a webhook POST actually came from PayPal, using PayPal's own
// verification API (there's no shared-secret HMAC like Stripe's — PayPal
// signs with a rotating cert and expects you to ask it to check the
// signature itself). See:
// https://developer.paypal.com/api/rest/webhooks/rest/#link-verifywebhooksignature
exports.verifyPaypalWebhookSignature = async (req) => {
  const accessToken = await exports.generatePaypalAccessToken();

  const response = await axios({
    url: `${endpoint_url}/v1/notifications/verify-webhook-signature`,
    method: "post",
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: PAYPAL_REQUEST_TIMEOUT_MS,
    data: {
      auth_algo: req.headers["paypal-auth-algo"],
      cert_url: req.headers["paypal-cert-url"],
      transmission_id: req.headers["paypal-transmission-id"],
      transmission_sig: req.headers["paypal-transmission-sig"],
      transmission_time: req.headers["paypal-transmission-time"],
      webhook_id: paypalWebhookId,
      webhook_event: req.body,
    },
  });

  return response?.data?.verification_status === "SUCCESS";
};

// Independent confirmation channel for PayPal payments, mirroring
// stripeWebhook in stripe.controller.js: the browser-driven capture in
// exports.capturePayment is a fast path, not the source of truth, because
// nothing guarantees that request completes (closed tab, dropped mobile
// connection, crashed app). This webhook lets PayPal tell us a payment
// succeeded even when that browser round trip never finishes.
exports.paypalWebhook = async (req, res, next) => {
  try {
    if (!paypalWebhookId) {
      // Genuinely worth alerting on, not just logging — this means the
      // webhook is completely non-functional in this environment.
      exports.logPaymentEvent({ gateway: "Paypal", eventType: "config_error" });
      next(new Error("No PayPal webhook ID configured for this environment; rejecting webhook."));
      return;
    }

    const isVerified = await exports.verifyPaypalWebhookSignature(req);
    if (!isVerified) {
      exports.logPaymentEvent({ gateway: "Paypal", eventType: "signature_rejected" });
      return res.status(400).send("Webhook signature verification failed");
    }

    const event = req.body;
    const paypalOrderId = event?.resource?.supplementary_data?.related_ids?.order_id;

    exports.logPaymentEvent({
      gateway: "Paypal",
      eventType: "webhook_received",
      gatewayReference: paypalOrderId,
      metadata: { event_type: event?.event_type, event_id: event?.id },
    });

    if (event?.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      if (paypalOrderId) {
        const order = await exports.updateOrderPaid(paypalOrderId);
        if (order?.paid) {
          console.log(`Order with PayPal id ${paypalOrderId} marked as paid via webhook.`);
          exports.logPaymentEvent({
            gateway: "Paypal",
            eventType: "marked_paid",
            orderId: order._id,
            gatewayReference: paypalOrderId,
          });
        }
      }
    } else if (event?.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      if (paypalOrderId) {
        const order = await Order.findOneAndUpdate({ paypalId: paypalOrderId }, { status: "Refunded" }, { new: true });
        console.log(`Order with PayPal id ${paypalOrderId} marked as refunded via webhook.`);
        exports.logPaymentEvent({
          gateway: "Paypal",
          eventType: "refunded",
          orderId: order?._id,
          gatewayReference: paypalOrderId,
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    // next(error), not a direct res.status(500) — routes through the global
    // error handler so a broken webhook actually alerts the admin instead of
    // failing silently into a console log nobody's watching in production.
    // Still lands as a 5xx either way, which is what makes PayPal retry.
    next(error);
  }
};
