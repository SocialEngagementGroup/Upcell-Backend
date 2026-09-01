const crypto = require("crypto");
const Order = require("../models/order.model");
const {
  makeOrderObjAndTotal,
  hasPendingCheckout,
  logPaymentEvent,
  orderTotal,
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

// The checkout form collects one "Name" field, but the gateway wants forename
// and surname separately and validates both.
//
// A single-word name used to send surname="-", which Secure Acceptance rejects
// as invalid field data — reason code 102, the whole transaction declined. Any
// customer entering just their first name hit it, and the error they saw said
// nothing about a name. Repeating the one word they gave us is valid data and
// costs nothing: AVS checks street and postal code, never the name.
const splitName = (fullName) => {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { forename: "Customer", surname: "Customer" };
  if (parts.length === 1) return { forename: parts[0], surname: parts[0] };
  return { forename: parts[0], surname: parts.slice(1).join(" ") };
};

// Secure Acceptance rejects a phone containing anything but digits — the
// "(313) 288-8312" a customer naturally types is invalid field data, again
// reason code 102. Strip to digits and cap at the gateway's 15-character
// limit; an empty result means send nothing rather than send garbage.
const toGatewayPhone = (value) => String(value || "").replace(/\D/g, "").slice(0, 15);

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// Secure Acceptance echoes every field we sent back with a "req_" prefix:
// req_reference_number, req_amount, req_transaction_uuid. Only values the
// gateway itself produces (decision, transaction_id, auth_amount) come back
// unprefixed.
//
// Reading the unprefixed name for an echoed field silently yields undefined,
// which is exactly how two ACCEPTed payments on 2026-09-01 were verified,
// logged, and then dropped: findById(undefined) returned null and the handler
// answered 200. The unprefixed fallback is kept only so a replayed older
// payload still resolves.
const echoed = (body, name) => body[`req_${name}`] ?? body[name];

// The amount is inside the signed field set, so a mismatch is not tampering —
// it means the bank authorised a different figure than the order is worth
// (a partial authorisation, or a bug on our side re-pricing between hand-off
// and confirmation). Either way that is not a payment we should mark complete
// without a human looking at it.
const AMOUNT_TOLERANCE = 0.01;

// On a rejection the gateway names every field it objected to, as invalidField_0,
// invalidField_1, ... Nothing read them, so a reason-102 decline ("one or more
// fields contain invalid data") arrived with the diagnosis attached and we threw
// it away — the cause had to be reconstructed by diffing paid against failed
// orders in the database. Capture them so the log says which field was wrong.
const invalidFields = (body) =>
  Object.keys(body)
    .filter((key) => /^invalidField_\d+$/.test(key))
    .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]))
    .map((key) => body[key]);

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
      bill_to_phone: toGatewayPhone(newOrder.phone),
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
        metadata: { reference_number: echoed(body, "reference_number") ?? null },
      });
      // 200 on purpose. A 4xx tells the bank "delivery failed, retry", and
      // retrying a forged request achieves nothing. Repeated rejections are a
      // security signal to investigate, not a delivery problem to solve.
      return res.sendStatus(200);
    }

    const referenceNumber = echoed(body, "reference_number");

    const rejectedFields = invalidFields(body);

    logPaymentEvent({
      gateway: GATEWAY,
      eventType: "webhook_received",
      gatewayReference: body.transaction_id,
      metadata: {
        decision: body.decision,
        reference_number: referenceNumber,
        reason_code: body.reason_code,
        message: body.message,
        // Present only on a rejection, and the single most useful thing in the
        // payload when one happens.
        ...(rejectedFields.length ? { invalid_fields: rejectedFields } : {}),
      },
    });

    // A confirmation whose reference we can't resolve means the bank believes
    // money moved against an order we cannot find. Never silently 200 that
    // away — it is the one event worth waking someone for.
    if (!OBJECT_ID_PATTERN.test(referenceNumber || "")) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "unmatched_confirmation",
        gatewayReference: body.transaction_id,
        metadata: {
          reason: "missing_or_malformed_reference",
          reference_number: referenceNumber ?? null,
          decision: body.decision,
        },
      });
      return res.sendStatus(200);
    }

    const order = await Order.findById(referenceNumber);
    if (!order) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "unmatched_confirmation",
        gatewayReference: body.transaction_id,
        metadata: {
          reason: "no_such_order",
          reference_number: referenceNumber,
          decision: body.decision,
        },
      });
      return res.sendStatus(200);
    }

    let status = DECISION_STATUS[body.decision] || "pending_payment";
    let paid = status === "Processing";

    // Confirm the bank authorised what the order is actually worth before
    // treating it as settled. auth_amount is the gateway's own figure; the
    // echoed req_amount is what we asked for.
    if (paid) {
      const expected = orderTotal(order);
      const authorised = Number(body.auth_amount ?? echoed(body, "amount"));
      const currency = String(echoed(body, "currency") || "").toLowerCase();
      const amountOk =
        Number.isFinite(authorised) &&
        Math.abs(authorised - expected) < AMOUNT_TOLERANCE;

      if (!amountOk || (currency && currency !== "usd")) {
        paid = false;
        status = "pending_payment";
        logPaymentEvent({
          gateway: GATEWAY,
          eventType: "amount_mismatch",
          orderId: order._id,
          gatewayReference: body.transaction_id,
          metadata: { expected, authorised, currency: currency || null },
        });
      }
    }

    // Claim the order atomically. The previous read-then-save left a window
    // where two retried confirmations both passed the "already handled?" check
    // and both sent the customer a receipt. The filter only matches an order
    // that has not been claimed yet, so exactly one writer wins — and in Mongo
    // `field: null` also matches documents where the field is absent.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, boaTransactionId: { $in: [null, ""] } },
      {
        $set: {
          status,
          paid,
          boaTransactionId: body.transaction_id,
          // Brand and last four only — enough to answer a customer's question,
          // useless to anyone who breaches the database.
          cardBrand: body.card_type_name || body.req_card_type,
          cardLast4: String(body.req_card_number || "").slice(-4) || undefined,
        },
      },
      { new: true }
    );

    if (!claimed) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "duplicate_confirmation",
        orderId: order._id,
        gatewayReference: body.transaction_id,
      });
      return res.sendStatus(200);
    }

    if (claimed.paid) {
      logPaymentEvent({
        gateway: GATEWAY,
        eventType: "marked_paid",
        orderId: claimed._id,
        gatewayReference: body.transaction_id,
      });
      sendPaymentReceiptEmail(claimed);
      sendAdminNewOrderEmail(claimed);
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
  const referenceNumber = echoed(body, "reference_number");

  // A forged response and a valid one we can't read are different problems —
  // the first is someone probing us, the second is a bug on our side. Logging
  // both as "signature_rejected" is what hid the req_ prefix mismatch: the
  // signature was fine every time, only the reference was unreadable.
  if (!valid) {
    logPaymentEvent({
      gateway: GATEWAY,
      eventType: "signature_rejected",
      metadata: { source: "customer_response", reference_number: referenceNumber ?? null },
    });
    return res.redirect(`${frontendUrl}/cart`);
  }

  // Guard the shape as well as the signature. Redirecting with a missing
  // reference_number would send the customer to /succeed?order_id=undefined,
  // and the thank-you page would then ask the API for an order called
  // "undefined".
  if (!OBJECT_ID_PATTERN.test(referenceNumber || "")) {
    logPaymentEvent({
      gateway: GATEWAY,
      eventType: "unmatched_confirmation",
      metadata: {
        source: "customer_response",
        reason: "missing_or_malformed_reference",
        reference_number: referenceNumber ?? null,
      },
    });
    return res.redirect(`${frontendUrl}/cart`);
  }

  const orderId = referenceNumber;

  if (DECISION_STATUS[body.decision] === "payment failed") {
    return res.redirect(`${frontendUrl}/cart?payment=failed`);
  }

  res.redirect(`${frontendUrl}/succeed?order_id=${orderId}`);
};
