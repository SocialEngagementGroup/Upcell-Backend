// The states a trade-in moves through.
//
// The same journey as a return run backwards, and the same map — because
// everything the returns system learned the hard way is true here too.

const {
  TRADE_IN_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  CLOCK_PAUSED_STATUSES,
  LEGACY_STATUS_MAP,
  isTradeInStatus,
  canTransition,
  transitionError,
} = require("../src/constants/tradeInStatus");

const { targetStatus } = require("../scripts/migrate-trade-in-status");
const { applyTransition, recordEvent } = require("../src/services/returnTimeline");
const tradeInStatus = require("../src/constants/tradeInStatus");

describe("the map itself", () => {
  it("gives every status somewhere to go, or says it is finished", () => {
    TRADE_IN_STATUSES.forEach((status) => {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(ALLOWED_TRANSITIONS[status])).toBe(true);
    });
  });

  it("never points at a status that does not exist", () => {
    // A typo here is a transition nothing can ever make, and it would only
    // show up when a staff member could not move a real request.
    Object.entries(ALLOWED_TRANSITIONS).forEach(([from, targets]) => {
      targets.forEach((to) => {
        expect(isTradeInStatus(to)).toBe(true);
        expect(to).not.toBe(from);
      });
    });
  });

  it("starts at Quoted, because there is nothing before a price", () => {
    // A return starts from an order UpCell already has. A trade-in starts
    // from a price UpCell offered.
    const reachable = new Set(Object.values(ALLOWED_TRANSITIONS).flat());
    expect(reachable.has("Quoted")).toBe(false);
  });

  it("ends only at Closed", () => {
    expect(TERMINAL_STATUSES).toEqual(["Closed"]);
  });

  it("can reach Closed from every terminal-ish state", () => {
    ["Paid", "Rejected", "ReturnShipped", "Expired", "Cancelled"].forEach((status) => {
      expect(ALLOWED_TRANSITIONS[status]).toContain("Closed");
    });
  });
});

describe("moves that must not be possible", () => {
  it("will not pay for a device nobody has seen", () => {
    // The entire point of the workflow is that the phone arrives and somebody
    // looks at it before money moves.
    expect(canTransition("Quoted", "Paid")).toBe(false);
    expect(canTransition("Quoted", "Approved")).toBe(false);
  });

  it("will not receive a device that never moved", () => {
    // A request at LabelIssued has a label printed and nothing more. Letting
    // it jump to received is how a trade-in is marked complete for a box on
    // somebody's kitchen table.
    expect(canTransition("LabelIssued", "DeviceReceived")).toBe(false);
  });

  it("keeps the carrier's word apart from a person's", () => {
    // "Delivered" is a claim about a doorstep. "DeviceReceived" is a claim
    // about a device in a hand. Inspection follows the second.
    expect(canTransition("Delivered", "InInspection")).toBe(false);
    expect(canTransition("DeviceReceived", "InInspection")).toBe(true);
  });

  it("will not move anything out of Closed", () => {
    TRADE_IN_STATUSES.forEach((status) => {
      expect(canTransition("Closed", status)).toBe(false);
    });
  });

  it("will not pay twice", () => {
    expect(ALLOWED_TRANSITIONS.Paid).toEqual(["Closed"]);
  });

  it("refuses a status nobody defined", () => {
    expect(canTransition("Quoted", "Refunded")).toBe(false);
    expect(canTransition("Submitted", "Quoted")).toBe(false);
  });
});

describe("moves that have to work", () => {
  it("walks the whole path from a quote to a payout", () => {
    const path = [
      "Quoted", "LabelIssued", "InTransit", "Delivered",
      "DeviceReceived", "InInspection", "Approved", "Paid", "Closed",
    ];

    path.slice(0, -1).forEach((from, i) => {
      expect(canTransition(from, path[i + 1])).toBe(true);
    });
  });

  it("lets a blocked device go back to inspection once it is cleared", () => {
    // Activation Lock parks a device; it does not fail it.
    expect(canTransition("InInspection", "ActionRequired")).toBe(true);
    expect(canTransition("ActionRequired", "InInspection")).toBe(true);
  });

  it("lets a revised offer be accepted or refused", () => {
    expect(canTransition("RevisedOffer", "Approved")).toBe(true);
    expect(canTransition("RevisedOffer", "Rejected")).toBe(true);
  });

  it("sends a refused device back to its owner", () => {
    expect(canTransition("Rejected", "ReturnShipped")).toBe(true);
  });

  it("lets every pre-money state be refused", () => {
    ["Quoted", "LabelIssued", "InTransit", "Delivered", "DeviceReceived", "InInspection"]
      .forEach((status) => expect(ALLOWED_TRANSITIONS[status]).toContain("Rejected"));
  });
});

describe("what counts as live", () => {
  it("does not hold a lapsed quote open", () => {
    // Somebody whose quote expired must be able to ask for a new one rather
    // than being told they already have a trade-in open.
    ["Expired", "Cancelled", "Rejected", "Closed", "Paid"].forEach((status) => {
      expect(ACTIVE_STATUSES).not.toContain(status);
    });
  });

  it("counts everything from the quote to the money as live", () => {
    expect(ACTIVE_STATUSES).toContain("Quoted");
    expect(ACTIVE_STATUSES).toContain("Approved");
  });

  it("stops the clock while waiting on the customer", () => {
    // A device sitting Activation Locked is not UpCell failing to pay.
    expect(CLOCK_PAUSED_STATUSES).toEqual(["ActionRequired", "RevisedOffer"]);
  });
});

describe("the message when a move is refused", () => {
  it("says where the request could go instead", () => {
    const message = transitionError("Quoted", "Paid");

    expect(message).toContain("Quoted");
    expect(message).toContain("Paid");
    expect(message).toContain("LabelIssued");
  });

  it("says plainly when a request is finished", () => {
    expect(transitionError("Closed", "Paid")).toContain("finished");
  });

  it("names a status that does not exist rather than guessing", () => {
    expect(transitionError("Quoted", "Banana")).toContain("not a trade-in status");
  });
});

describe("moving a request with the timeline service", () => {
  const request = (status) => ({ status, timeline: [] });

  it("moves it and writes the move down", () => {
    const doc = request("Quoted");
    const result = applyTransition(doc, "LabelIssued", {
      actor: "yasir@upcellit.com", actorType: "staff", machine: tradeInStatus,
    });

    expect(result.ok).toBe(true);
    expect(doc.status).toBe("LabelIssued");
    expect(doc.timeline[0]).toMatchObject({ from: "Quoted", to: "LabelIssued", actorType: "staff" });
  });

  it("refuses an illegal move and changes nothing", () => {
    const doc = request("Quoted");
    const result = applyTransition(doc, "Paid", { machine: tradeInStatus });

    expect(result.ok).toBe(false);
    expect(doc.status).toBe("Quoted");
    expect(doc.timeline).toHaveLength(0);
  });

  it("checks against the returns map when nobody says otherwise", () => {
    // A missed argument has to fail loudly. Quoted is not a return status, so
    // a trade-in moved without its own map goes nowhere at all.
    const doc = request("Quoted");

    expect(applyTransition(doc, "LabelIssued").ok).toBe(false);
  });

  it("still moves a return the way it always did", () => {
    const doc = { status: "Submitted", timeline: [] };

    expect(applyTransition(doc, "ReturnApproved").ok).toBe(true);
    expect(doc.status).toBe("ReturnApproved");
  });

  it("only ever appends to the timeline", () => {
    const doc = request("Quoted");
    recordEvent(doc, { event: "quote_sent" });
    applyTransition(doc, "LabelIssued", { machine: tradeInStatus });
    applyTransition(doc, "InTransit", { machine: tradeInStatus });

    expect(doc.timeline).toHaveLength(3);
    expect(doc.timeline[0].event).toBe("quote_sent");
  });
});

describe("migrating the six old statuses", () => {
  it("covers every old value", () => {
    expect(Object.keys(LEGACY_STATUS_MAP).sort()).toEqual(
      ["Closed", "Contacted", "New", "Paid", "Quoted", "Received"]
    );
  });

  it("maps every old value onto a status that exists", () => {
    Object.values(LEGACY_STATUS_MAP).forEach((status) => {
      expect(isTradeInStatus(status)).toBe(true);
    });
  });

  it("turns New into a quote", () => {
    expect(targetStatus({ status: "New" })).toMatchObject({ status: "Quoted", changed: true });
  });

  it("turns Contacted into a quote too", () => {
    // "Contacted" recorded that somebody had emailed, which is not a state of
    // the device.
    expect(targetStatus({ status: "Contacted" }).status).toBe("Quoted");
  });

  it("turns Received into a device in hand", () => {
    expect(targetStatus({ status: "Received" }).status).toBe("DeviceReceived");
  });

  it("leaves Paid and Closed where they are", () => {
    expect(targetStatus({ status: "Paid" })).toMatchObject({ status: "Paid", changed: false });
    expect(targetStatus({ status: "Closed" })).toMatchObject({ status: "Closed", changed: false });
  });

  it("reads a changed estimate as a revised offer", () => {
    // Somebody edited the price by hand after looking at the device.
    const result = targetStatus({
      status: "Quoted",
      estimateCents: 40000,
      quoteBreakdown: [{ step: "final", resultCents: 66100 }],
    });

    expect(result.status).toBe("RevisedOffer");
  });

  it("reads a matching estimate as an untouched quote", () => {
    const result = targetStatus({
      status: "Quoted",
      estimateCents: 66100,
      quoteBreakdown: [{ step: "final", resultCents: 66100 }],
    });

    expect(result.status).toBe("Quoted");
  });

  it("allows a dollar of rounding either way", () => {
    // The old records stored dollars and the breakdown stores cents. A
    // rounding difference is not somebody revising a price.
    const result = targetStatus({
      status: "Quoted",
      estimate: 661,
      quoteBreakdown: [{ step: "final", resultCents: 66149 }],
    });

    expect(result.status).toBe("Quoted");
  });

  it("falls back to an open quote when there is nothing to compare", () => {
    // A customer with an open quote and no deadline is a conversation. A
    // customer with a deadline they were never told about is a complaint.
    expect(targetStatus({ status: "Quoted", estimateCents: 40000 }).status).toBe("Quoted");
    expect(targetStatus({ status: "Quoted", quoteBreakdown: [] }).status).toBe("Quoted");
  });

  it("leaves a request already on the machine alone", () => {
    expect(targetStatus({ status: "InInspection" })).toMatchObject({
      status: "InInspection", changed: false,
    });
  });

  it("reports a status nothing maps rather than guessing", () => {
    const result = targetStatus({ status: "Weird" });

    expect(result.status).toBeNull();
    expect(result.why).toContain("unknown status");
  });
});
