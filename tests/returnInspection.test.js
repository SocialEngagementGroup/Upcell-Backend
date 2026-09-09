const {
  validateInspection,
  suggestOutcome,
  suggestDisposition,
  gradeFrom,
  stampPurgeDates,
} = require("../src/services/returnInspection");
const {
  CHECKLIST_ITEMS,
  REQUIRED_PHOTO_COUNT,
  PHOTO_RETENTION_DAYS,
} = require("../src/constants/inspectionChecklist");

// Every check answered "pass", which is the as-described case.
const allPass = (overrides = {}) =>
  CHECKLIST_ITEMS.map((item) => ({
    key: item.key,
    result: overrides[item.key] || "pass",
  }));

const photos = (count = REQUIRED_PHOTO_COUNT) =>
  Array.from({ length: count }, (_, index) => ({
    url: `https://cdn/photo-${index}.jpg`,
    publicId: `upcell/returns/photo-${index}`,
  }));

describe("validateInspection", () => {
  it("accepts a complete inspection", () => {
    expect(validateInspection({ checklist: allPass(), photos: photos(), faultClaimed: true }).ok)
      .toBe(true);
  });

  it("refuses an unanswered check", () => {
    const checklist = allPass().filter((entry) => entry.key !== "powers_on");

    const result = validateInspection({ checklist, photos: photos(), faultClaimed: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Powers on/i);
  });

  it("does not demand the fault check when no fault was claimed", () => {
    // Otherwise a change-of-mind return trains staff to type "na" eleven times,
    // which is how a checklist stops being read.
    const checklist = allPass().filter((entry) => entry.key !== "fault_reproduced");

    expect(validateInspection({ checklist, photos: photos(), faultClaimed: false }).ok).toBe(true);
  });

  it("demands it when a fault was claimed", () => {
    const checklist = allPass().filter((entry) => entry.key !== "fault_reproduced");

    expect(validateInspection({ checklist, photos: photos(), faultClaimed: true }).ok).toBe(false);
  });

  it("refuses fewer than five photos, and says how many are attached", () => {
    const result = validateInspection({ checklist: allPass(), photos: photos(4), faultClaimed: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/4 attached/);
  });

  it("refuses a photo with no Cloudinary id", () => {
    // It could never be deleted, so it would sit in the account forever and
    // quietly break the 90-day purge.
    const bad = [...photos(4), { url: "https://cdn/orphan.jpg" }];

    const result = validateInspection({ checklist: allPass(), photos: bad, faultClaimed: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Cloudinary id/i);
  });

  it("refuses an answer that is not pass, fail or na", () => {
    const checklist = allPass();
    checklist[0].result = "probably";

    expect(validateInspection({ checklist, photos: photos(), faultClaimed: true }).ok).toBe(false);
  });

  it("refuses a check that does not exist", () => {
    const checklist = [...allPass(), { key: "vibes", result: "pass" }];

    const result = validateInspection({ checklist, photos: photos(), faultClaimed: true });

    expect(result.errors.join(" ")).toMatch(/vibes/);
  });

  it("reports every problem at once, not one per submission", () => {
    const result = validateInspection({ checklist: [], photos: [], faultClaimed: true });

    expect(result.errors.length).toBeGreaterThan(5);
  });
});

describe("suggestOutcome", () => {
  it("sends a locked device to ActionRequired, not to rejection", () => {
    // Rejecting it costs postage and starts an argument over something the
    // customer can clear from their phone in two minutes.
    const result = suggestOutcome({ checklist: allPass({ activation_lock: "fail" }) });

    expect(result.outcome).toBe("ACTION_REQUIRED");
    expect(result.reason).toMatch(/Activation Lock/i);
  });

  it("checks the lock before anything else", () => {
    // A locked device that is also scuffed is still a lock problem first.
    const result = suggestOutcome({
      checklist: allPass({ activation_lock: "fail", body_condition: "fail" }),
    });

    expect(result.outcome).toBe("ACTION_REQUIRED");
  });

  it("rejects a device that is not the one that was sold", () => {
    expect(suggestOutcome({ checklist: allPass({ imei_matches: "fail" }) }).outcome).toBe("REJECT");
  });

  it("rejects a liquid-damaged device", () => {
    expect(suggestOutcome({ checklist: allPass({ liquid_damage: "fail" }) }).outcome).toBe("REJECT");
  });

  it("offers less when a claimed fault does not reproduce", () => {
    // It stops being UpCell's fault, which changes the postage and the fee.
    const result = suggestOutcome({
      checklist: allPass({ fault_reproduced: "fail" }),
      faultClaimed: true,
    });

    expect(result.outcome).toBe("REVISED_OFFER");
    expect(result.reason).toMatch(/did not reproduce/i);
  });

  it("ignores the fault check when no fault was claimed", () => {
    const result = suggestOutcome({
      checklist: allPass({ fault_reproduced: "fail" }),
      faultClaimed: false,
    });

    expect(result.outcome).toBe("FULL_REFUND");
  });

  it("offers less for a device in worse condition than described", () => {
    const result = suggestOutcome({ checklist: allPass({ body_condition: "fail" }) });

    expect(result.outcome).toBe("REVISED_OFFER");
    expect(result.reason).toMatch(/body_condition/);
  });

  it("refunds in full when the device is as described", () => {
    expect(suggestOutcome({ checklist: allPass() }).outcome).toBe("FULL_REFUND");
  });

  it("does not treat a broken seal as a reason to pay less", () => {
    // Opening the box is what a return is. It changes where the device goes,
    // not what the customer is owed.
    expect(suggestOutcome({ checklist: allPass({ seal_intact: "fail" }) }).outcome)
      .toBe("FULL_REFUND");
  });
});

describe("suggestDisposition", () => {
  it("puts a sealed device back into new stock", () => {
    expect(suggestDisposition({ checklist: allPass(), outcome: "FULL_REFUND" }).type)
      .toBe("RESTOCK_NEW");
  });

  it("sends a dead device back to the supplier", () => {
    const result = suggestDisposition({
      checklist: allPass({ seal_intact: "fail", powers_on: "fail" }),
      outcome: "REVISED_OFFER",
    });

    expect(result.type).toBe("RETURN_TO_SUPPLIER");
  });

  it("marks an opened but working device OPEN_BOX", () => {
    // Recorded distinctly even though it routes to wholesale today, so where
    // these go is a policy change later rather than a rebuild.
    const result = suggestDisposition({
      checklist: allPass({ seal_intact: "fail" }),
      outcome: "FULL_REFUND",
    });

    expect(result.type).toBe("OPEN_BOX");
  });

  it("suggests nothing for a device being sent back to the customer", () => {
    expect(suggestDisposition({ checklist: allPass(), outcome: "REJECT" })).toBeNull();
  });
});

describe("gradeFrom", () => {
  it("grades a perfect device A", () => {
    expect(gradeFrom(allPass())).toBe("A");
  });

  it("grades one cosmetic problem B", () => {
    expect(gradeFrom(allPass({ body_condition: "fail" }))).toBe("B");
  });

  it("grades two cosmetic problems C", () => {
    expect(gradeFrom(allPass({ body_condition: "fail", accessories: "fail" }))).toBe("C");
  });

  it("grades any functional problem C", () => {
    expect(gradeFrom(allPass({ screen_touch: "fail" }))).toBe("C");
    expect(gradeFrom(allPass({ battery_health: "fail" }))).toBe("C");
  });

  it("fails a device that is dead, wet, or not the right one", () => {
    for (const key of ["powers_on", "liquid_damage", "imei_matches"]) {
      expect(gradeFrom(allPass({ [key]: "fail" }))).toBe("FAIL");
    }
  });

  it("does not downgrade for a broken seal", () => {
    expect(gradeFrom(allPass({ seal_intact: "fail" }))).toBe("A");
  });
});

describe("stampPurgeDates", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("marks every photo for deletion 90 days out", () => {
    const stamped = stampPurgeDates(photos(2), now);

    const expected = new Date(now.getTime() + PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(stamped.every((photo) => photo.purgeAfter.getTime() === expected.getTime())).toBe(true);
  });

  it("keeps the Cloudinary id, which is what the purge deletes by", () => {
    expect(stampPurgeDates(photos(1), now)[0].publicId).toBe("upcell/returns/photo-0");
  });

  it("defaults takenAt to now rather than leaving it empty", () => {
    expect(stampPurgeDates([{ publicId: "x", url: "https://cdn/x.jpg" }], now)[0].takenAt)
      .toEqual(now);
  });

  it("drops anything the caller attached that is not a photo field", () => {
    // Whatever the admin client posts, only these five fields are stored.
    const stamped = stampPurgeDates([{ publicId: "x", url: "u", evil: true }], now);

    expect(Object.keys(stamped[0]).sort()).toEqual(
      ["caption", "publicId", "purgeAfter", "takenAt", "url"]
    );
  });
});
