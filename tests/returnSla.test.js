const {
  addBusinessDays,
  startClock,
  pauseClock,
  resumeClock,
  syncClockToStatus,
  isOverdue,
  hoursRemaining,
  SETTLEMENT_BUSINESS_DAYS,
} = require("../src/services/returnSla");

// 2026-09-10 is a Thursday.
const thursday = new Date("2026-09-10T14:00:00Z");
const friday = new Date("2026-09-11T14:00:00Z");
const hours = (n) => n * 60 * 60 * 1000;

describe("addBusinessDays", () => {
  it("promises two business days", () => {
    expect(SETTLEMENT_BUSINESS_DAYS).toBe(2);
  });

  it("adds two days midweek", () => {
    // Thursday + 2 = Saturday on a calendar, but Monday in business days.
    expect(addBusinessDays(thursday, 2).toISOString().slice(0, 10)).toBe("2026-09-14");
  });

  it("skips the weekend from a Friday", () => {
    // A Friday inspection is due Tuesday. Getting this wrong means either
    // chasing staff over a weekend or quietly breaking a promise.
    expect(addBusinessDays(friday, 2).toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("keeps the time of day, so a deadline is not silently moved to midnight", () => {
    expect(addBusinessDays(thursday, 2).getUTCHours()).toBe(14);
  });

  it("never lands on a weekend", () => {
    for (let day = 0; day < 14; day += 1) {
      const start = new Date(thursday.getTime() + day * 24 * 60 * 60 * 1000);
      const due = addBusinessDays(start, 2);

      expect([0, 6]).not.toContain(due.getUTCDay());
    }
  });
});

describe("the clock", () => {
  it("starts at inspection and sets a deadline", () => {
    const request = {};

    startClock(request, thursday);

    expect(request.sla.clockStartedAt).toEqual(thursday);
    expect(request.sla.dueAt.toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(request.sla.breached).toBe(false);
  });

  it("pauses, recording when", () => {
    const request = {};
    startClock(request, thursday);

    pauseClock(request, new Date(thursday.getTime() + hours(4)));

    expect(request.sla.clockPausedAt).toBeInstanceOf(Date);
  });

  it("gives back exactly the time the pause cost", () => {
    // A return with four hours left when it paused has four hours left when it
    // resumes — not two fresh days.
    const request = {};
    startClock(request, thursday);
    const originalDue = request.sla.dueAt.getTime();

    pauseClock(request, new Date(thursday.getTime() + hours(1)));
    resumeClock(request, new Date(thursday.getTime() + hours(25)));

    expect(request.sla.dueAt.getTime() - originalDue).toBe(hours(24));
    expect(request.sla.clockPausedAt).toBeUndefined();
  });

  it("does not reset the deadline on resume", () => {
    // Resetting would let a request be parked and unparked to escape the queue
    // forever.
    const request = {};
    startClock(request, thursday);
    pauseClock(request, new Date(thursday.getTime() + hours(1)));
    resumeClock(request, new Date(thursday.getTime() + hours(2)));

    expect(request.sla.clockStartedAt).toEqual(thursday);
  });

  it("keeps the first pause when paused twice", () => {
    // Otherwise the second call silently forgives the time between them.
    const request = {};
    startClock(request, thursday);
    const first = new Date(thursday.getTime() + hours(1));

    pauseClock(request, first);
    pauseClock(request, new Date(thursday.getTime() + hours(5)));

    expect(request.sla.clockPausedAt).toEqual(first);
  });

  it("ignores a resume that was never paused", () => {
    const request = {};
    startClock(request, thursday);
    const due = request.sla.dueAt.getTime();

    resumeClock(request, new Date(thursday.getTime() + hours(10)));

    expect(request.sla.dueAt.getTime()).toBe(due);
  });

  it("does nothing on a request whose clock never started", () => {
    const request = {};

    expect(() => pauseClock(request, thursday)).not.toThrow();
    expect(request.sla).toBeUndefined();
  });
});

describe("syncClockToStatus", () => {
  it("pauses when UpCell is waiting on the customer", () => {
    for (const status of ["ActionRequired", "RevisedOffer"]) {
      const request = {};
      startClock(request, thursday);

      syncClockToStatus(request, status, new Date(thursday.getTime() + hours(1)));

      expect(request.sla.clockPausedAt).toBeInstanceOf(Date);
    }
  });

  it("resumes when the ball is back with UpCell", () => {
    const request = {};
    startClock(request, thursday);
    syncClockToStatus(request, "ActionRequired", new Date(thursday.getTime() + hours(1)));

    syncClockToStatus(request, "InInspection", new Date(thursday.getTime() + hours(3)));

    expect(request.sla.clockPausedAt).toBeUndefined();
  });

  it("does not pause while the device is being worked on", () => {
    const request = {};
    startClock(request, thursday);

    syncClockToStatus(request, "InInspection", new Date(thursday.getTime() + hours(1)));

    expect(request.sla.clockPausedAt).toBeUndefined();
  });
});

describe("isOverdue", () => {
  const withDue = (dueAt, extra = {}) => ({
    status: "Approved",
    sla: { dueAt, ...extra },
  });

  it("is late once the deadline has passed", () => {
    expect(isOverdue(withDue(new Date(thursday.getTime() - hours(1))), thursday)).toBe(true);
  });

  it("is not late before it", () => {
    expect(isOverdue(withDue(new Date(thursday.getTime() + hours(1))), thursday)).toBe(false);
  });

  it("is not late while paused — the ball is with the customer", () => {
    const request = withDue(new Date(thursday.getTime() - hours(5)), { clockPausedAt: thursday });

    expect(isOverdue(request, thursday)).toBe(false);
  });

  it("is not late once the return has finished, whatever the deadline said", () => {
    for (const status of ["Refunded", "Closed", "Rejected", "ReturnShipped", "Cancelled", "Expired"]) {
      const request = { status, sla: { dueAt: new Date(thursday.getTime() - hours(100)) } };

      expect(isOverdue(request, thursday)).toBe(false);
    }
  });

  it("is not late when no clock is running", () => {
    expect(isOverdue({ status: "Submitted" }, thursday)).toBe(false);
  });
});

describe("hoursRemaining", () => {
  it("counts down", () => {
    expect(hoursRemaining({ sla: { dueAt: new Date(thursday.getTime() + hours(6)) } }, thursday))
      .toBe(6);
  });

  it("goes negative once late, so a queue can sort by how late", () => {
    expect(hoursRemaining({ sla: { dueAt: new Date(thursday.getTime() - hours(3)) } }, thursday))
      .toBe(-3);
  });

  it("is null when nothing is running", () => {
    expect(hoursRemaining({}, thursday)).toBeNull();
  });
});
