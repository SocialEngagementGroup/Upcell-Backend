// Importing a spreadsheet of devices, and counting what is sellable.
//
// Adding stock a row at a time through the admin form is fine for one phone
// and unworkable for a pallet of two hundred. The shape of this endpoint
// follows from what goes wrong with bulk imports rather than from what is
// convenient: every row is checked before any row is written, the whole file
// can be run as a dry run first, and nothing is ever updated — each row is one
// physical device arriving, so an import only ever adds.

const ParentProduct = require("../models/parentProduct.model");
const SingleVariation = require("../models/singleVariation.model");
const AuditLog = require("../models/auditLog.model");
const { identityRequired } = require("../constants/deviceIdentity");
const { variantSlug, ensureUniqueSlug } = require("../utils/slug");
const {
  COLUMNS,
  MAX_BYTES,
  MAX_ROWS,
  parseCsv,
  checkHeaders,
  readRow,
  duplicatesWithin,
} = require("../services/productImport");

// Case-insensitive without a regex. Building one from a model name typed into
// a spreadsheet means a cell containing ".*" matches every product in the
// catalogue, and a long enough pattern hangs the server.
const INSENSITIVE = { locale: "en", strength: 2 };

/**
 * POST /admin-products/import
 *
 * Body: { csv: string, dryRun?: boolean }
 *
 * Answers with a per-row report either way. A dry run is the same work with
 * the write left off, so what it reports is what an import would do rather
 * than a guess at it.
 */
async function importProducts(req, res, next) {
  try {
    const csv = String(req.body?.csv || "");
    const dryRun = req.body?.dryRun === true;

    if (!csv.trim()) {
      return res.status(400).json({ error: "No CSV was sent." });
    }
    if (Buffer.byteLength(csv, "utf8") > MAX_BYTES) {
      return res.status(413).json({ error: `That file is larger than ${MAX_BYTES / 1024 / 1024}MB.` });
    }

    const { headers, rows } = parseCsv(csv);

    const headerCheck = checkHeaders(headers);
    if (!headerCheck.ok) {
      return res.status(400).json({ error: headerCheck.error });
    }
    if (!rows.length) {
      return res.status(400).json({ error: "The file has a header row and nothing under it." });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ error: `That file has ${rows.length} rows. The limit is ${MAX_ROWS}.` });
    }

    const requireIdentity = identityRequired();
    const failures = [];
    const accepted = [];

    // Every model named in the file, looked up once. One query rather than one
    // per row: a 300-row import of the same four models is four lookups.
    const namesInFile = [...new Set(
      rows.map((row) => String(row[headers.indexOf("modelName")] ?? "").trim()).filter(Boolean)
    )];

    const parents = namesInFile.length
      ? await ParentProduct.find({ modelName: { $in: namesInFile } })
        .collation(INSENSITIVE)
        .select("_id modelName categoryName categoryId images")
        .lean()
      : [];

    const parentByName = new Map(parents.map((doc) => [String(doc.modelName).trim().toLowerCase(), doc]));

    rows.forEach((row, index) => {
      // Line numbers as a person reading the spreadsheet sees them: the header
      // is line 1, so the first record is line 2. Off by one here means every
      // error in the report points at the wrong row.
      const line = index + 2;
      const modelName = String(row[headers.indexOf("modelName")] ?? "").trim();
      const parent = parentByName.get(modelName.toLowerCase());

      const { errors, value } = readRow(headers, row, {
        categoryName: parent?.categoryName,
        identityRequired: requireIdentity,
      });

      const reasons = [...errors];

      // Checked after the row itself, so a row with a typo in the model name
      // still reports its other problems in the same pass. Being told about
      // one mistake per upload is how a 200-row file takes a week.
      if (modelName && !parent) {
        reasons.push(`there is no product called "${modelName}" — create it once in Add Product, then import its units`);
      }

      if (reasons.length) failures.push({ line, modelName, reasons });
      else accepted.push({ line, parent, value });
    });

    // Two devices cannot share an identity, so a file listing one twice is a
    // counting mistake somebody needs to go and resolve on the shelf.
    const internalClashes = duplicatesWithin(accepted);

    // And the same check against what is already in the catalogue.
    const identities = accepted.flatMap(({ value }) =>
      [value.imei && { imei: value.imei }, value.serialNumber && { serialNumber: value.serialNumber }].filter(Boolean)
    );

    const alreadyHere = identities.length
      ? await SingleVariation.find({ $or: identities }).select("imei serialNumber").lean()
      : [];

    const takenImeis = new Set(alreadyHere.map((doc) => doc.imei).filter(Boolean));
    const takenSerials = new Set(alreadyHere.map((doc) => doc.serialNumber).filter(Boolean));

    const clean = [];
    accepted.forEach((entry) => {
      const reasons = [];
      const withinFile = internalClashes.get(entry.line);
      if (withinFile) reasons.push(withinFile);
      if (entry.value.imei && takenImeis.has(entry.value.imei)) {
        reasons.push(`imei ${entry.value.imei} is already on a unit in the catalogue`);
      }
      if (entry.value.serialNumber && takenSerials.has(entry.value.serialNumber)) {
        reasons.push(`serialNumber ${entry.value.serialNumber} is already on a unit in the catalogue`);
      }

      if (reasons.length) failures.push({ line: entry.line, modelName: entry.value.modelName, reasons });
      else clean.push(entry);
    });

    failures.sort((a, b) => a.line - b.line);

    const report = {
      dryRun,
      rows: rows.length,
      wouldImport: clean.length,
      imported: 0,
      failed: failures.length,
      errors: failures,
    };

    if (dryRun || !clean.length) {
      return res.status(200).json(report);
    }

    // Slugs are built in sequence rather than in parallel: two rows of the
    // same model, storage and colour produce the same base slug, and each
    // needs to see the one before it to pick the next free suffix.
    const docs = [];
    for (const { parent, value } of clean) {
      const base = variantSlug({
        productName: parent.modelName,
        storage: value.storage,
        color: value.color,
      });
      const slug = await ensureUniqueSlug(base, async (candidate) =>
        docs.some((doc) => doc.slug === candidate) ||
        Boolean(await SingleVariation.exists({ slug: candidate }))
      );

      docs.push({
        parentCatagory: parent._id,
        slug,
        productName: parent.modelName,
        categoryName: parent.categoryName,
        categoryId: parent.categoryId || undefined,
        // The product family's photo. An import has no way to supply one per
        // unit, and marking it generic is what lets a real photo replace it
        // later instead of being treated as somebody's deliberate choice.
        image: parent.images?.[0]?.url,
        imagePublicId: parent.images?.[0]?.publicId,
        imageIsGeneric: true,
        storage: value.storage,
        color: value.color,
        price: value.price,
        cosmeticGrade: value.cosmeticGrade,
        batteryHealth: value.batteryHealth,
        carrierStatus: value.carrierStatus,
        deviceType: value.deviceType,
        refurbState: value.refurbState,
        acquisitionSource: value.acquisitionSource,
        imei: value.imei,
        serialNumber: value.serialNumber,
        isAccessory: false,
        outOfStock: false,
      });
    }

    // Unordered, so one row the unique index rejects between the check above
    // and this write does not abandon the other 199.
    let inserted = [];
    try {
      inserted = await SingleVariation.insertMany(docs, { ordered: false });
    } catch (error) {
      inserted = error?.insertedDocs || [];
      (error?.writeErrors || []).forEach((failure) => {
        const at = failure.index ?? failure.err?.index;
        const entry = clean[at];
        failures.push({
          line: entry?.line ?? null,
          modelName: entry?.value?.modelName ?? null,
          reasons: ["another import saved this device first — check the IMEI or serial"],
        });
      });
      failures.sort((a, b) => a.line - b.line);
    }

    report.imported = inserted.length;
    report.failed = failures.length;
    report.errors = failures;

    // One row per product family rather than one per import, because an audit
    // log is read by asking "what happened to this product" — and because
    // targetId has to point at something real. "Who added forty iPhone 13s,
    // and when" is the question this has to be able to answer.
    const perFamily = new Map();
    inserted.forEach((doc) => {
      const key = String(doc.parentCatagory);
      const entry = perFamily.get(key) || { parentId: doc.parentCatagory, name: doc.productName, units: 0 };
      entry.units += 1;
      perFamily.set(key, entry);
    });

    await Promise.all([...perFamily.values()].map((entry) =>
      AuditLog.create({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: "product.imported",
        targetType: "ParentProduct",
        targetId: entry.parentId,
        metadata: {
          productName: entry.name,
          units: entry.units,
          // The whole file's shape, so a partly failed import is legible from
          // any one of its rows rather than only from the response nobody kept.
          fileRows: rows.length,
          fileImported: report.imported,
          fileFailed: report.failed,
        },
      })
    )).catch(() => {});

    return res.status(200).json(report);
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /admin-stock-summary
 *
 * How much of the catalogue can actually be sold, by product family.
 *
 * "In stock" and "sellable" are not the same thing and the difference is the
 * whole point of this: a device with a battery under 80% is in the building,
 * works, and must not be listed. Counted here so the gap is visible rather
 * than discovered when somebody asks why the shop looks empty.
 */
async function getStockSummary(req, res, next) {
  try {
    const rows = await SingleVariation.aggregate([
      { $match: { isAccessory: { $ne: true } } },
      {
        $group: {
          _id: { parent: "$parentCatagory", name: "$productName" },
          total: { $sum: 1 },
          sellable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$outOfStock", true] },
                    { $in: [{ $ifNull: ["$refurbState", "SELLABLE"] }, ["SELLABLE"]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          needsBattery: { $sum: { $cond: [{ $eq: ["$refurbState", "NEEDS_BATTERY"] }, 1, 0] } },
          needsRepair: { $sum: { $cond: [{ $eq: ["$refurbState", "NEEDS_REPAIR"] }, 1, 0] } },
          sold: { $sum: { $cond: [{ $eq: ["$outOfStock", true] }, 1, 0] } },
        },
      },
      // Emptiest first. The list is read to decide what to buy, and a family
      // with nothing sellable is the one worth seeing without scrolling.
      { $sort: { sellable: 1, "_id.name": 1 } },
    ]);

    const families = rows.map((row) => ({
      parentId: row._id.parent ? String(row._id.parent) : null,
      productName: row._id.name || "Unnamed",
      total: row.total,
      sellable: row.sellable,
      needsBattery: row.needsBattery,
      needsRepair: row.needsRepair,
      sold: row.sold,
    }));

    const totals = families.reduce(
      (sum, family) => ({
        total: sum.total + family.total,
        sellable: sum.sellable + family.sellable,
        needsBattery: sum.needsBattery + family.needsBattery,
        needsRepair: sum.needsRepair + family.needsRepair,
        sold: sum.sold + family.sold,
      }),
      { total: 0, sellable: 0, needsBattery: 0, needsRepair: 0, sold: 0 }
    );

    return res.status(200).json({ totals, families });
  } catch (error) {
    return next(error);
  }
}

module.exports = { importProducts, getStockSummary, COLUMNS };
