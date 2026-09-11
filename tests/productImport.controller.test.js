jest.mock("../src/models/parentProduct.model");
jest.mock("../src/models/singleVariation.model");
jest.mock("../src/models/auditLog.model");

const ParentProduct = require("../src/models/parentProduct.model");
const SingleVariation = require("../src/models/singleVariation.model");
const AuditLog = require("../src/models/auditLog.model");
const { importProducts, getStockSummary } = require("../src/controllers/productImport.controller");

const PARENT_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

const makeReqRes = (body = {}) => {
  const req = { body, params: {}, user: { id: "user_admin", email: "yasir@upcellit.com", role: "admin" } };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return { req, res, next: jest.fn() };
};

const sent = (res) => res.json.mock.calls[0][0];

const HEADER = "modelName,storage,color,price,cosmeticGrade,batteryHealth,carrierStatus,imei,serialNumber";
const line = (over = {}) => {
  const v = {
    modelName: "iPhone 13",
    storage: "128GB",
    color: "Midnight",
    price: "499",
    cosmeticGrade: "GOOD",
    batteryHealth: "92",
    carrierStatus: "Unlocked",
    imei: "123456789012345",
    serialNumber: "",
    ...over,
  };
  return HEADER.split(",").map((name) => v[name]).join(",");
};

// The catalogue knows about iPhone 13 and nothing else.
const catalogueKnowsTheModel = () => {
  ParentProduct.find.mockReturnValue({
    collation: () => ({
      select: () => ({
        lean: () => Promise.resolve([{
          _id: PARENT_ID,
          modelName: "iPhone 13",
          categoryName: "iPhone",
          images: [{ url: "https://img/x.jpg", publicId: "x" }],
        }]),
      }),
    }),
  });
};

const nothingWithThatIdentity = () => {
  SingleVariation.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REQUIRE_DEVICE_IDENTITY;

  catalogueKnowsTheModel();
  nothingWithThatIdentity();
  SingleVariation.exists.mockResolvedValue(false);
  SingleVariation.insertMany.mockImplementation((docs) =>
    Promise.resolve(docs.map((doc, i) => ({ ...doc, _id: `id_${i}` })))
  );
  AuditLog.create.mockResolvedValue({});
});

describe("a dry run", () => {
  it("says what would happen and writes nothing", async () => {
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n`, dryRun: true });
    await importProducts(req, res, next);

    expect(sent(res)).toMatchObject({ dryRun: true, rows: 1, wouldImport: 1, imported: 0, failed: 0 });
    expect(SingleVariation.insertMany).not.toHaveBeenCalled();
  });

  it("reports the same failures a real import would", async () => {
    // A dry run nobody can trust is worse than no dry run, because it is the
    // step that makes somebody confident enough to press the button.
    const csv = `${HEADER}\n${line({ price: "" })}\n`;
    const { req, res, next } = makeReqRes({ csv, dryRun: true });
    await importProducts(req, res, next);

    expect(sent(res).failed).toBe(1);
    expect(sent(res).errors[0].reasons).toContain("price is empty");
  });
});

describe("importing for real", () => {
  it("writes the good rows", async () => {
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n` });
    await importProducts(req, res, next);

    expect(sent(res)).toMatchObject({ dryRun: false, imported: 1, failed: 0 });

    const [docs] = SingleVariation.insertMany.mock.calls[0];
    expect(docs[0]).toMatchObject({
      parentCatagory: PARENT_ID,
      productName: "iPhone 13",
      categoryName: "iPhone",
      price: 499,
      carrierStatus: "UNLOCKED",
      deviceType: "PHONE",
      refurbState: "SELLABLE",
      acquisitionSource: "BULK",
      isAccessory: false,
      outOfStock: false,
    });
  });

  it("marks the family photo as a stand-in, not as somebody's choice", async () => {
    // An import has no way to supply a photo per unit. Saying so is what lets
    // a real photo replace it later instead of being left alone.
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n` });
    await importProducts(req, res, next);

    const [docs] = SingleVariation.insertMany.mock.calls[0];
    expect(docs[0].imageIsGeneric).toBe(true);
    expect(docs[0].image).toBe("https://img/x.jpg");
  });

  it("keeps the good rows when one is bad", async () => {
    const csv = `${HEADER}\n${line()}\n${line({ price: "free", imei: "123456789012346" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res)).toMatchObject({ rows: 2, imported: 1, failed: 1 });
  });

  it("writes nothing at all when every row is bad", async () => {
    const csv = `${HEADER}\n${line({ price: "" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(SingleVariation.insertMany).not.toHaveBeenCalled();
    expect(sent(res).imported).toBe(0);
  });

  it("does not abandon the rest of the file when one write is rejected", async () => {
    // The unique index can reject a row between the check and the write if
    // two people import at once. 199 devices should not be lost to it.
    const failure = Object.assign(new Error("dup"), {
      insertedDocs: [{ parentCatagory: PARENT_ID, productName: "iPhone 13" }],
      writeErrors: [{ index: 1 }],
    });
    SingleVariation.insertMany.mockRejectedValue(failure);

    const csv = `${HEADER}\n${line()}\n${line({ imei: "123456789012346" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).imported).toBe(1);
    expect(sent(res).failed).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("rows the catalogue will not take", () => {
  it("refuses a model nobody has created yet, and says how to fix it", async () => {
    // Creating a product family from a typo in a spreadsheet is how a
    // catalogue ends up with "iPhone 13" and "iphone 13 ".
    const csv = `${HEADER}\n${line({ modelName: "iPhone 99" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).errors[0].reasons[0]).toContain("iPhone 99");
    expect(sent(res).errors[0].reasons[0]).toContain("Add Product");
  });

  it("matches a model name whatever case it was typed in", async () => {
    const csv = `${HEADER}\n${line({ modelName: "IPHONE 13" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).failed).toBe(0);
  });

  it("uses a collation rather than building a regex from the cell", async () => {
    // A model name of ".*" as a regex matches the whole catalogue, and a long
    // enough pattern hangs the server.
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n` });
    await importProducts(req, res, next);

    const [filter] = ParentProduct.find.mock.calls[0];
    expect(filter.modelName.$in[0] instanceof RegExp).toBe(false);
  });

  it("refuses a device already in the catalogue under another product", async () => {
    SingleVariation.find.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([{ imei: "123456789012345" }]) }),
    });

    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n` });
    await importProducts(req, res, next);

    expect(sent(res).errors[0].reasons[0]).toContain("already on a unit");
    expect(SingleVariation.insertMany).not.toHaveBeenCalled();
  });

  it("refuses the same device listed twice in one file", async () => {
    const csv = `${HEADER}\n${line()}\n${line()}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).failed).toBe(1);
    expect(sent(res).errors[0].reasons[0]).toContain("line 2");
  });

  it("numbers errors the way the spreadsheet does, header first", async () => {
    // Off by one here and every error in the report points at the wrong row,
    // which is worse than no report.
    const csv = `${HEADER}\n${line()}\n${line({ price: "", imei: "123456789012346" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).errors[0].line).toBe(3);
  });

  it("reports a bad row's other problems as well as its unknown model", async () => {
    const csv = `${HEADER}\n${line({ modelName: "iPhone 99", price: "" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    expect(sent(res).errors[0].reasons).toHaveLength(2);
  });
});

describe("the file itself", () => {
  it("refuses an empty upload", async () => {
    const { req, res, next } = makeReqRes({ csv: "   " });
    await importProducts(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  it("refuses a file missing a column it cannot do without", async () => {
    const { req, res, next } = makeReqRes({ csv: "storage,color\n128GB,Midnight\n" });
    await importProducts(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("modelName");
  });

  it("refuses a header row with nothing under it", async () => {
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n` });
    await importProducts(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(sent(res).error).toContain("nothing under it");
  });

  it("refuses a file too big to be an import", async () => {
    const { req, res, next } = makeReqRes({ csv: "x".repeat(2 * 1024 * 1024 + 1) });
    await importProducts(req, res, next);

    expect(res.statusCode).toBe(413);
  });
});

describe("the audit row", () => {
  it("records who imported how many units of what", async () => {
    // "Who added forty iPhone 13s, and when" is the question this has to be
    // able to answer months later.
    const csv = `${HEADER}\n${line()}\n${line({ imei: "123456789012346" })}\n`;
    const { req, res, next } = makeReqRes({ csv });
    await importProducts(req, res, next);

    const [entry] = AuditLog.create.mock.calls[0];
    expect(entry).toMatchObject({
      actorEmail: "yasir@upcellit.com",
      action: "product.imported",
      targetType: "ParentProduct",
      targetId: PARENT_ID,
    });
    expect(entry.metadata.units).toBe(2);
  });

  it("writes nothing for a dry run", async () => {
    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n`, dryRun: true });
    await importProducts(req, res, next);

    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it("still reports the import when the audit write fails", async () => {
    // The devices are already saved. Failing the response would tell an admin
    // the import did not happen when it did.
    AuditLog.create.mockRejectedValue(new Error("audit down"));

    const { req, res, next } = makeReqRes({ csv: `${HEADER}\n${line()}\n` });
    await importProducts(req, res, next);

    expect(sent(res).imported).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("what can actually be sold", () => {
  it("counts sellable apart from in stock", async () => {
    // A device under 80% battery is in the building, works, and must not be
    // listed. Counting it as stock is how the shop looks fuller than it is.
    SingleVariation.aggregate.mockResolvedValue([
      { _id: { parent: PARENT_ID, name: "iPhone 13" }, total: 10, sellable: 6, needsBattery: 3, needsRepair: 1, sold: 0 },
    ]);

    const { req, res, next } = makeReqRes();
    await getStockSummary(req, res, next);

    expect(sent(res).families[0]).toMatchObject({
      productName: "iPhone 13", total: 10, sellable: 6, needsBattery: 3, needsRepair: 1,
    });
  });

  it("adds the families up", async () => {
    SingleVariation.aggregate.mockResolvedValue([
      { _id: { parent: PARENT_ID, name: "iPhone 13" }, total: 10, sellable: 6, needsBattery: 3, needsRepair: 1, sold: 0 },
      { _id: { parent: "b", name: "iPad Air" }, total: 4, sellable: 4, needsBattery: 0, needsRepair: 0, sold: 2 },
    ]);

    const { req, res, next } = makeReqRes();
    await getStockSummary(req, res, next);

    expect(sent(res).totals).toEqual({ total: 14, sellable: 10, needsBattery: 3, needsRepair: 1, sold: 2 });
  });

  it("leaves accessories out, because they are not units", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    const { req, res, next } = makeReqRes();
    await getStockSummary(req, res, next);

    const [pipeline] = SingleVariation.aggregate.mock.calls[0];
    expect(pipeline[0].$match.isAccessory).toEqual({ $ne: true });
  });

  it("answers an empty catalogue with zeroes rather than nothing", async () => {
    SingleVariation.aggregate.mockResolvedValue([]);

    const { req, res, next } = makeReqRes();
    await getStockSummary(req, res, next);

    expect(sent(res)).toEqual({ families: [], totals: { total: 0, sellable: 0, needsBattery: 0, needsRepair: 0, sold: 0 } });
  });
});
