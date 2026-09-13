const { recordEvent, applyTransition } = require("../src/services/returnTimeline");

const req = (status = "Submitted", timeline = []) => ({ status, timeline });

describe("recordEvent", () => {
  it("appends rather than replacing", () => {
    const request = req("Submitted", [{ event: "created" }]);

    recordEvent(request, { event: "note_added" });

    expect(request.timeline).toHaveLength(2);
    expect(request.timeline[0].event).toBe("created");
  });

  it("starts a timeline on a request that has none", () => {
    const request = { status: "Submitted" };

    recordEvent(request, { event: "created" });

    expect(request.timeline).toHaveLength(1);
  });

  it("attributes the actor, because that is the whole point of the log", () => {
    const request = req();

    recordEvent(request, { event: "approved", actor: "yasir@upcellit.com", actorType: "staff" });

    expect(request.timeline[0]).toMatchObject({
      actor: "yasir@upcellit.com",
      actorType: "staff",
    });
  });

  it("falls back to system rather than leaving an entry unattributed", () => {
    const request = req();

    recordEvent(request, { event: "expired" });

    expect(request.timeline[0].actor).toBe("system");
    expect(request.timeline[0].actorType).toBe("system");
  });

  it("stamps the time itself, so a caller cannot backdate an entry", () => {
    const request = req();
    const before = Date.now();

    recordEvent(request, { event: "approved" });

    expect(request.timeline[0].at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps whatever context the caller attaches", () => {
    const request = req();

    recordEvent(request, { event: "rejected", meta: { rejectionReason: "Screen cracked" } });

    expect(request.timeline[0].meta).toEqual({ rejectionReason: "Screen cracked" });
  });

  it("does nothing on a missing request instead of throwing", () => {
    expect(recordEvent(null, { event: "x" })).toBeNull();
  });
});

describe("applyTransition", () => {
  it("moves the status and logs the move together", () => {
    const request = req("Submitted");

    const result = applyTransition(request, "ReturnApproved", {
      actor: "yasir@upcellit.com", actorType: "staff",
    });

    expect(result.ok).toBe(true);
    expect(request.status).toBe("ReturnApproved");
    expect(request.timeline[0]).toMatchObject({
      event: "status_changed",
      from: "Submitted",
      to: "ReturnApproved",
      actor: "yasir@upcellit.com",
    });
  });

  it("refuses an illegal move and changes nothing", () => {
    const request = req("Submitted");

    const result = applyTransition(request, "Refunded");

    expect(result.ok).toBe(false);
    // Both matter: a refused move must not half-happen.
    expect(request.status).toBe("Submitted");
    expect(request.timeline).toHaveLength(0);
  });

  it("explains the refusal and lists what is allowed instead", () => {
    const result = applyTransition(req("Submitted"), "Refunded");

    expect(result.error).toMatch(/Submitted/);
    expect(result.allowed).toContain("ReturnApproved");
  });

  it("refuses a status that does not exist", () => {
    const request = req("Submitted");

    const result = applyTransition(request, "Teleported");

    expect(result.ok).toBe(false);
    expect(request.status).toBe("Submitted");
  });

  it("refuses to move a finished request", () => {
    const request = req("Closed");

    expect(applyTransition(request, "Submitted").ok).toBe(false);
    expect(request.status).toBe("Closed");
  });

  it("builds a readable history over several moves", () => {
    const request = req("Submitted");

    applyTransition(request, "ReturnApproved", { actor: "staff1", actorType: "staff" });
    applyTransition(request, "InTransit", { actor: "staff2", actorType: "staff" });
    applyTransition(request, "DeviceReceived", { actor: "staff2", actorType: "staff" });

    expect(request.timeline.map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      "Submitted->ReturnApproved",
      "ReturnApproved->InTransit",
      "InTransit->DeviceReceived",
    ]);
    // Who did which step is the part that settles a dispute.
    expect(request.timeline.map((entry) => entry.actor)).toEqual(["staff1", "staff2", "staff2"]);
  });
});
