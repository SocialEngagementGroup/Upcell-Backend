// Where each carrier's own tracking page lives.
//
// Built from the carrier and the number rather than stored on the order, so a
// carrier changing its URL is one edit here instead of a migration over every
// order ever shipped.
//
// Shared by the controller that records a shipment and the view the customer
// reads, because a link that differs between the email and the account page is
// a support ticket.
const TRACKING_URLS = {
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  UPS: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  DHL: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(n)}`,
};

/**
 * The carrier's tracking page for this number, or null.
 *
 * "Other" deliberately gets nothing. A guessed URL that 404s is worse than the
 * bare number, which a customer can paste into any tracking site themselves.
 */
function trackingUrlFor(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const build = TRACKING_URLS[carrier];
  return build ? build(trackingNumber) : null;
}

module.exports = { trackingUrlFor, TRACKING_URLS };
