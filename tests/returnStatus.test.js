const {
  RETURN_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  CLOCK_PAUSED_STATUSES,
  canTransition,
  transitionError,
  isReturnStatus,
} = require("../src/constants/returnStatus");

describe("return status map — shape", () => {
  it("has a transition list for every status, and no status outside the map", () => {
    for (const status of RETURN_STATUSES) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[status])).toBe(true);
    }
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...RETURN_STATUSES].sort());
  });

  it("never points at a status that does not exist", () => {
    // A typo in the map would otherwise create a state nothing can leave.
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of targets) {
        expect(RETURN_STATUSES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it("keeps the six original statuses, so stored requests still load", () => {
    for (const status of ["Submitted", "ReturnApproved", "DeviceReceived", "Approved", "Refunded", "Rejected"]) {
      expect(RETURN_STATUSES).toContain(status);
    }
  });

  it("can reach every status from Submitted", () => {
    // Any status nothing leads to is dead code that a request can never enter.
    const seen = new Set(["Submitted"]);
    const queue = ["Submitted"];

    while (queue.length) {
      for (const next of ALLOWED_TRANSITIONS[queue.shift()]) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }

    expect([...seen].sort()).toEqual([...RETURN_STATUSES].sort());
  });
});

describe("the moves that matter", () => {
  it("will not let a request skip the device coming back", () => {
    // The whole point of the workflow: money moves only after someone has held
    // the device.
    expect(canTransition("Submitted", "Approved")).toBe(false);
    expect(canTransition("Submitted", "Refunded")).toBe(false);
    expect(canTransition("ReturnApproved", "Approved")).toBe(false);
  });

  it("treats a carrier saying Delivered as different from staff confirming receipt", () => {
    expect(canTransition("Delivered", "DeviceReceived")).toBe(true);
    // Inspection follows a person holding the device, not a doorstep scan.
    expect(canTransition("Delivered", "InInspection")).toBe(false);
  });

  it("will not mark a device received straight off a printed label", () => {
    // A request at LabelIssued has a label and nothing more. Jumping to
    // received is how a return gets marked complete for a box still on a
    // customer's kitchen table.
    expect(canTransition("LabelIssued", "DeviceReceived")).toBe(false);
    expect(canTransition("ReturnApproved", "DeviceReceived")).toBe(false);
  });

  it("receives only from in transit or delivered", () => {
    expect(canTransition("InTransit", "DeviceReceived")).toBe(true);
    expect(canTransition("Delivered", "DeviceReceived")).toBe(true);
  });

  it("lets staff mark a parcel in transit by hand while tracking is manual", () => {
    // One extra click until the FedEx Track API polls for it.
    expect(canTransition("ReturnApproved", "InTransit")).toBe(true);
    expect(canTransition("LabelIssued", "InTransit")).toBe(true);
  });

  it("allows rejection from every stage before money moves", () => {
    for (const status of ["Submitted", "ReturnApproved", "LabelIssued", "InTransit", "Delivered", "DeviceReceived", "InInspection", "RevisedOffer"]) {
      expect(canTransition(status, "Rejected")).toBe(true);
    }
  });

  it("does not allow rejection once the refund is approved or paid", () => {
    expect(canTransition("Approved", "Rejected")).toBe(false);
    expect(canTransition("Refunded", "Rejected")).toBe(false);
  });

  it("sends a rejected device back before closing", () => {
    expect(canTransition("Rejected", "ReturnShipped")).toBe(true);
    expect(canTransition("ReturnShipped", "Closed")).toBe(true);
  });

  it("lets a blocked inspection resume once the customer clears it", () => {
    expect(canTransition("InInspection", "ActionRequired")).toBe(true);
    expect(canTransition("ActionRequired", "InInspection")).toBe(true);
  });

  it("resolves a revised offer either way", () => {
    expect(canTransition("RevisedOffer", "Approved")).toBe(true);
    expect(canTransition("RevisedOffer", "Rejected")).toBe(true);
  });

  it("lets an unshipped authorisation expire or be cancelled", () => {
    expect(canTransition("Submitted", "Expired")).toBe(true);
    expect(canTransition("LabelIssued", "Expired")).toBe(true);
    expect(canTransition("Submitted", "Cancelled")).toBe(true);
    // Not once UpCell has the device — that is a rejection, not an expiry.
    expect(canTransition("DeviceReceived", "Expired")).toBe(false);
  });

  it("stops at Closed", () => {
    expect(ALLOWED_TRANSITIONS.Closed).toEqual([]);
    expect(TERMINAL_STATUSES).toEqual(["Closed"]);
  });
});

describe("active statuses", () => {
  it("counts every status where the request still occupies its order", () => {
    for (const status of ["Submitted", "ReturnApproved", "LabelIssued", "InTransit", "Delivered", "DeviceReceived", "InInspection", "ActionRequired", "RevisedOffer", "Approved"]) {
      expect(ACTIVE_STATUSES).toContain(status);
    }
  });

  it("frees the order once the request ends", () => {
    // A customer refused over a mistake on the form has to be able to submit a
    // corrected one, so these must not block a second request.
    for (const status of ["Rejected", "Expired", "Cancelled", "Closed", "Refunded", "ReturnShipped"]) {
      expect(ACTIVE_STATUSES).not.toContain(status);
    }
  });
});

describe("the settlement clock", () => {
  it("pauses only where UpCell is waiting on the customer", () => {
    expect(CLOCK_PAUSED_STATUSES).toEqual(["ActionRequired", "RevisedOffer"]);
  });

  it("does not pause while the device is simply being worked on", () => {
    expect(CLOCK_PAUSED_STATUSES).not.toContain("InInspection");
    expect(CLOCK_PAUSED_STATUSES).not.toContain("DeviceReceived");
  });
});

describe("transitionError — refusals a staff member can read", () => {
  it("says nothing when the move is fine", () => {
    expect(transitionError("Submitted", "ReturnApproved")).toBeNull();
  });

  it("names the statuses that are allowed instead", () => {
    const message = transitionError("Submitted", "Refunded");

    expect(message).toMatch(/ReturnApproved/);
    expect(message).toMatch(/Submitted/);
  });

  it("explains that a finished request cannot change", () => {
    expect(transitionError("Closed", "Submitted")).toMatch(/finished/i);
  });

  it("catches a status that does not exist, in either position", () => {
    expect(transitionError("Nonsense", "Closed")).toMatch(/not a return status/);
    expect(transitionError("Closed", "Nonsense")).toMatch(/not a return status/);
    expect(isReturnStatus("Nonsense")).toBe(false);
  });

  it("says so when the request is already in that status", () => {
    expect(transitionError("Submitted", "Submitted")).toMatch(/already/i);
  });
});
