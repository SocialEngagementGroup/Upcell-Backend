const {
  CARRIERS,
  validateShipment,
  trackingNumberInUse,
  recordInboundLeg,
  recordOutboundLeg,
  normaliseTracking,
} = require("../src/services/returnShipping");

describe("validateShipment", () => {
  const valid = { carrier: "FedEx", trackingNumber: "794123456789", labelUrl: "https://cdn/label.pdf" };

  it("accepts a real shipment", () => {
    expect(validateShipment(valid)).toMatchObject({ ok: true, carrier: "FedEx" });
  });

  it("uppercases the tracking number, so a lookup finds it either way", () => {
    // Staff type it off a label; customers paste it from an email. Both have to
    // match the same stored value.
    expect(validateShipment({ ...valid, trackingNumber: "  abc123456  " }).trackingNumber)
      .toBe("ABC123456");
  });

  it("refuses a carrier UpCell does not ship with", () => {
    const result = validateShipment({ ...valid, carrier: "Pigeon" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("FedEx");
  });

  it("refuses an empty or too-short tracking number", () => {
    for (const trackingNumber of ["", "   ", "794"]) {
      expect(validateShipment({ ...valid, trackingNumber }).ok).toBe(false);
    }
  });

  it("refuses a pasted URL in the tracking field", () => {
    // The commonest real mistake: someone copies the whole tracking link.
    expect(validateShipment({ ...valid, trackingNumber: "https://fedex.com/track?x=794123456789" }).ok)
      .toBe(false);
  });

  it("accepts the formats carriers actually use", () => {
    for (const trackingNumber of ["794123456789", "1Z999AA10123456784", "9400-1000-0000-0000-0000-00"]) {
      expect(validateShipment({ ...valid, trackingNumber }).ok).toBe(true);
    }
  });

  it("refuses a label link that is not https", () => {
    expect(validateShipment({ ...valid, labelUrl: "http://cdn/label.pdf" }).ok).toBe(false);
  });

  it("allows no label at all, for a customer posting it themselves", () => {
    expect(validateShipment({ carrier: "USPS", trackingNumber: "9400100000000000000000" }).ok).toBe(true);
  });

  it("offers FedEx, which the plan uses both ways", () => {
    expect(CARRIERS).toContain("FedEx");
  });
});

describe("trackingNumberInUse", () => {
  const model = (found) => ({
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => found }) })),
  });

  it("finds a clash on another open return", async () => {
    const RefundRequest = model({ _id: "other", rmaNumber: "RMA-2026-00099" });

    const clash = await trackingNumberInUse({
      RefundRequest, activeStatuses: ["Submitted"], trackingNumber: "794123456789",
    });

    expect(clash.rmaNumber).toBe("RMA-2026-00099");
  });

  it("searches both legs, since a ship-back number can collide too", async () => {
    const RefundRequest = model(null);

    await trackingNumberInUse({
      RefundRequest, activeStatuses: ["Submitted"], trackingNumber: "794123456789",
    });

    const query = RefundRequest.findOne.mock.calls[0][0];
    const fields = query.$or.map((clause) => Object.keys(clause)[0]);
    expect(fields).toEqual([
      "shipping.inbound.trackingNumber",
      "shipping.outbound.trackingNumber",
    ]);
  });

  it("does not count the request being edited as a clash with itself", async () => {
    // Correcting a typo on the same request must not be refused.
    const RefundRequest = model(null);

    await trackingNumberInUse({
      RefundRequest, activeStatuses: ["Submitted"], trackingNumber: "X", exceptId: "req1",
    });

    expect(RefundRequest.findOne.mock.calls[0][0]._id).toEqual({ $ne: "req1" });
  });

  it("only looks at live returns — a closed one may keep its number", async () => {
    const RefundRequest = model(null);

    await trackingNumberInUse({
      RefundRequest, activeStatuses: ["Submitted", "LabelIssued"], trackingNumber: "X",
    });

    expect(RefundRequest.findOne.mock.calls[0][0].status).toEqual({
      $in: ["Submitted", "LabelIssued"],
    });
  });

  it("normalises before comparing", async () => {
    const RefundRequest = model(null);

    await trackingNumberInUse({
      RefundRequest, activeStatuses: [], trackingNumber: " abc123 ",
    });

    expect(RefundRequest.findOne.mock.calls[0][0].$or[0]["shipping.inbound.trackingNumber"])
      .toBe("ABC123");
  });
});

describe("recording a leg", () => {
  it("bills the customer for postage when the return was their choice", () => {
    const request = { faultAttribution: "CUSTOMER" };

    recordInboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.inbound.paidBy).toBe("CUSTOMER");
  });

  it("bills UpCell when the return is UpCell's own doing", () => {
    const request = { faultAttribution: "UPCELL" };

    recordInboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.inbound.paidBy).toBe("UPCELL");
  });

  it("bills UpCell when nobody has decided yet", () => {
    // OTHER leaves attribution null. Erring toward UpCell paying is recoverable;
    // billing a customer who turns out to be blameless is not.
    const request = {};

    recordInboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.inbound.paidBy).toBe("UPCELL");
  });

  it("does not claim the parcel has shipped just because a label exists", () => {
    // The label being printed is not the box being handed over. Marking it
    // shipped here makes every unposted return look like it is in the post.
    const request = { faultAttribution: "CUSTOMER" };

    recordInboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.inbound.shippedAt).toBeUndefined();
  });

  it("keeps what was already recorded when a label is replaced", () => {
    const request = {
      faultAttribution: "CUSTOMER",
      shipping: { inbound: { shippedAt: new Date("2026-09-01"), labelCost: 12 } },
    };

    recordInboundLeg(request, { carrier: "FedEx", trackingNumber: "999888777666" });

    expect(request.shipping.inbound.shippedAt).toEqual(new Date("2026-09-01"));
    expect(request.shipping.inbound.trackingNumber).toBe("999888777666");
  });

  it("always bills UpCell for a ship-back, whoever was at fault", () => {
    // UpCell absorbs the return leg on a rejection rather than holding the
    // device while an already-unhappy customer decides whether to pay.
    const request = { faultAttribution: "CUSTOMER" };

    recordOutboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.outbound.paidBy).toBe("UPCELL");
  });

  it("marks a ship-back as shipped, because it leaves as it is recorded", () => {
    const request = {};

    recordOutboundLeg(request, { carrier: "FedEx", trackingNumber: "794123456789" });

    expect(request.shipping.outbound.shippedAt).toBeInstanceOf(Date);
  });

  it("does not lose the other leg when writing one", () => {
    const request = { shipping: { inbound: { trackingNumber: "INBOUND1" } } };

    recordOutboundLeg(request, { carrier: "FedEx", trackingNumber: "OUTBOUND1" });

    expect(request.shipping.inbound.trackingNumber).toBe("INBOUND1");
    expect(request.shipping.outbound.trackingNumber).toBe("OUTBOUND1");
  });
});

describe("normaliseTracking", () => {
  it("copes with nothing", () => {
    expect(normaliseTracking(null)).toBe("");
    expect(normaliseTracking(undefined)).toBe("");
  });
});
