const crypto = require("crypto");
const Order = require("../models/order.model");
const {
  makeOrderObjAndTotal,
  hasPendingCheckout,
  logPaymentEvent,
  sendPaymentReceiptEmail,
  sendAdminNewOrderEmail,
} = require("./checkout.controller");

const GATEWAY = "BankOfAmerica";

const accessKey = process.env.BOA_ACCESS_KEY;
const secretKey = process.env.BOA_SECRET_KEY;
const profileId = process.env.BOA_PROFILE_ID;
const endpoint = process.env.BOA_ENDPOINT;
const frontendUrl = process.env.FRONTEND_URL;

// Secure Acceptance signs a flat "k=v,k=v" string built from the field names
// listed in signed_field_names, in exactly that order — not the JSON body and
// not a sorted key list. Rebuilding it the same way on both sides is the whole
// contract, so this helper is the single place that knows the format.
const buildDataToSign = (fields, fieldNames) =>
  fieldNames.map((name) => `${name}=${fields[name] ?? ""}`).join(",");

const hmac = (data) =>
  crypto.createHmac("sha256", secretKey).update(data, "utf8").digest("base64");

// signed_field_names lists itself, which reads oddly but is required: without
// it, an attacker could drop a field from the list and from the payload and
// still produce a signature that verified.
exports.buildSignedFields = (fields) => {
  const fieldNames = [...Object.keys(fields), "signed_field_names"];
  const withNames = { ...fields, signed_field_names: fieldNames.join(",") };
  return { ...withNames, signature: hmac(buildDataToSign(withNames, fieldNames)) };
};

// Constant-time comparison. A plain === leaks how many leading characters
// matched through response timing, which is enough to forge a signature one
// character at a time given enough attempts.
exports.verifySignature = (body) => {
  if (!body?.signature || !body?.signed_field_names) return false;

  const fieldNames = String(body.signed_field_names).split(",");
  const expected = Buffer.from(hmac(buildDataToSign(body, fieldNames)));
  const received = Buffer.from(String(body.signature));

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
};

// The gateway wants a 2-letter ISO country code. Our checkout form collects
// free text, so "United States" arrives where "US" is expected. We only ship
// within the US (see Delivery Policy), so anything unrecognised falls back to
// US rather than failing the payment over a formatting difference.
const toCountryCode = (value) => {
  const raw = String(value || "").trim();
  if (raw.length === 2) return raw.toUpperCase();
  if (/united\s*states|^usa$|^u\.s\.?a?\.?$/i.test(raw)) return "US";
  return "US";
};

// Secure Acceptance wants "2026-09-01T14:32:05Z" — ISO 8601 with no
// milliseconds. toISOString() includes them, which the gateway rejects.
const signedDateTime = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const splitName = (fullName) => {
  const parts = String(fullName || "").trim().split(/\s+/);
  if (parts.length < 2) return { forename: parts[0] || "Customer", surname: "-" };
  return { forename: parts[0], surname: parts.slice(1).join(" ") };
};

// Step 1 of the flow. The order is written before signing so its _id can be
// the reference_number — that _id is the only thing tying the bank's later
// confirmation back to an order.
exports.preparePayment = async (req, res, next) => {
  try {
    if (!accessKey || !secretKey || !endpoint || !profileId) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "config_error",
        metadata: {
          missing: [
            !accessKey && "BOA_ACCESS_KEY",
            !secretKey && "BOA_SECRET_KEY",
            !endpoint && "BOA_ENDPOINT",
            !profileId && "BOA_PROFILE_ID",
          ].filter(Boolean),
        },
      });
      return res.status(500).json({ error: "Payment is not configured." });
    }

    if (await hasPendingCheckout(req.body?.email)) {
      return res
        .status(409)
        .json({ error: "A checkout for this email is already in progress." });
    }

    const { order, totalPrice } = await makeOrderObjAndTotal({
      req,
      paidWith: GATEWAY,
    });

    const transactionUuid = crypto.randomUUID();
    const newOrder = await Order.create({
      ...order,
      boaTransactionUuid: transactionUuid,
    });

    const { forename, surname } = splitName(newOrder.name);

    // authorization, not sale: devices ship after checkout, so the money is
    // only captured at dispatch. A sale here would take payment for something
    // still sitting on the shelf.
    const fields = exports.buildSignedFields({
      access_key: accessKey,
      // Identifies which Secure Acceptance profile to run this through. Without
      // it the gateway can't resolve the configuration and rejects the whole
      // request with a 403 "not authorized" before processing anything.
      profile_id: profileId,
      transaction_uuid: transactionUuid,
      signed_date_time: signedDateTime(),
      locale: "en",
      transaction_type: "authorization",
      reference_number: newOrder._id.toString(),
      amount: totalPrice.toFixed(2),
      currency: "usd",
      // Billing Information is switched off on the hosted payment form, so the
      // bank has no other source for these. Without them AVS has nothing to
      // check against and the "reverse on failed AVS" rule misfires.
      bill_to_forename: forename,
      bill_to_surname: surname,
      bill_to_email: newOrder.email,
      bill_to_phone: newOrder.phone,
      bill_to_address_line1: newOrder.street,
      bill_to_address_city: newOrder.city,
      bill_to_address_state: newOrder.state || "",
      bill_to_address_postal_code: newOrder.postal,
      bill_to_address_country: toCountryCode(newOrder.country),
    });

    res.json({ endpoint, fields, orderId: newOrder._id });
  } catch (error) {
    next(error);
  }
};

const DECISION_STATUS = {
  ACCEPT: "Processing",
  DECLINE: "payment failed",
  ERROR: "payment failed",
  CANCEL: "payment failed",
};

// Step 2. This is the only thing that marks an order paid — the customer's
// browser coming back proves nothing, since anyone can request that URL.
exports.merchantPost = async (req, res, next) => {
  try {
    const body = req.body || {};

    if (!exports.verifySignature(body)) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "signature_rejected",
        gatewayReference: body.transaction_id,
        metadata: { reference_number: body.reference_number },
      });
      // 200 on purpose. A 4xx tells the bank "delivery failed, retry", and
      // retrying a forged request achieves nothing. Repeated rejections are a
      // security signal to investigate, not a delivery problem to solve.
      return res.sendStatus(200);
    }

    logPaymentEvent({
      gateway: GATEWAY,
      eventType: "webhook_received",
      gatewayReference: body.transaction_id,
      metadata: { decision: body.decision, reference_number: body.reference_number },
    });

    const order = await Order.findById(body.reference_number);
    if (!order) return res.sendStatus(200);

    // The bank retries when it doesn't get a clean response, so the same
    // confirmation can arrive more than once. Anything past this point runs
    // exactly once per transaction.
    if (order.boaTransactionId) return res.sendStatus(200);

    const status = DECISION_STATUS[body.decision] || "pending_payment";

    order.status = status;
    order.paid = status === "Processing";
    order.boaTransactionId = body.transaction_id;
    // Brand and last four only — enough to answer a customer's question,
    // useless to anyone who breaches the database.
    order.cardBrand = body.card_type_name || body.req_card_type;
    order.cardLast4 = String(body.req_card_number || "").slice(-4) || undefined;
    await order.save();

    if (order.paid) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "marked_paid",
        orderId: order._id,
        gatewayReference: body.transaction_id,
      });
      sendPaymentReceiptEmail(order);
      sendAdminNewOrderEmail(order);
    }

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
};

// Step 3. Where the customer's browser lands. It verifies the signature only
// so we don't redirect on a forged response — it never writes payment status.
exports.paymentResponse = async (req, res) => {
  const body = req.body || {};
  const valid = exports.verifySignature(body);
  // Guard the shape as well as the signature. Redirecting with a missing
  // reference_number would send the customer to /succeed?order_id=undefined,
  // and the thank-you page would then ask the API for an order called
  // "undefined".
  const orderId = valid && /^[0-9a-fA-F]{24}$/.test(body.reference_number || "")
    ? body.reference_number
    : "";

  if (!valid || !orderId) {
    logPaymentEvent({
      gateway: GATEWAY,
      eventType: "signature_rejected",
      metadata: { source: "customer_response", reference_number: body.reference_number },
    });
    return res.redirect(`${frontendUrl}/cart`);
  }

  if (DECISION_STATUS[body.decision] === "payment failed") {
    return res.redirect(`${frontendUrl}/cart?payment=failed`);
  }

  res.redirect(`${frontendUrl}/succeed?order_id=${orderId}`);
};
