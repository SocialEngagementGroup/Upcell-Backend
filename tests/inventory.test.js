jest.mock("../src/models/singleVariation.model");

const SingleVariation = require("../src/models/singleVariation.model");
const {
  reserveVariations,
  releaseReservation,
  holdForReview,
  markSold,
  variationIdsFromOrder,
  HOLD_MS,
  REVIEW_HOLD_MS,
} = require("../src/services/inventory");

const PHONE_A = "68b59c07d4a1e2b8c3f10a51";
const PHONE_B = "68b59c07d4a1e2b8c3f10a52";
const CASE = "6a993469be5e6e2340492b33";

// findOneAndUpdate(...).lean() — the claim. Returns the doc when the filter
// matched (we won), null when it did not (someone else holds it, or it is sold).
const claimReturns = (byId) => {
  SingleVariation.findOneAndUpdate.mockImplementation((filter) => ({
    lean: async () => (byId[String(filter._id)] === false ? null : { _id: filter._id }),
  }));
};

// Before claiming anything, reserveVariations asks which of these ids are
// stock-controlled devices — accessories are stocked in quantity and must not
// be held for one customer. Unless a test says otherwise, everything it passes
// in is a device.
const stockableIsEverything = () => {
  SingleVariation.find.mockImplementation((filter) => ({
    select: () => ({
      lean: async () => (filter._id?.$in || []).map((_id) => ({ _id })),
    }),
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
  stockableIsEverything();
  SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 0 });
  SingleVariation.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ productName: "iPhone 13" }) }),
  });
});

describe("holding a device during checkout", () => {
  it("holds every device in the cart", async () => {
    claimReturns({});

    const result = await reserveVariations([PHONE_A, PHONE_B], "checkout-1");

    expect(result.ok).toBe(true);
    expect(SingleVariation.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("claims in one atomic write, not a read then a write", async () => {
    claimReturns({});

    await reserveVariations([PHONE_A], "checkout-1");

    // Checking availability and then writing is two steps, and two checkouts
    // can both pass the check before either writes. The filter and the update
    // must travel together.
    const [filter, update] = SingleVariation.findOneAndUpdate.mock.calls[0];
    expect(filter.outOfStock).toEqual({ $ne: true });
    expect(filter.$or).toBeDefined();
    expect(update.$set.reservedFor).toBe("checkout-1");
    expect(update.$set.reservedUntil).toBeInstanceOf(Date);
  });

  it("refuses when someone else already holds the device", async () => {
    claimReturns({ [PHONE_A]: false });

    const result = await reserveVariations([PHONE_A], "checkout-2");

    expect(result.ok).toBe(false);
    expect(result.unavailable[0].id).toBe(PHONE_A);
    expect(result.unavailable[0].message).toContain("iPhone 13");
  });

  it("puts back what it already took when a later device is gone", async () => {
    // A partly-reserved cart would either charge for something the customer
    // cannot receive, or quietly drop something they chose to buy.
    claimReturns({ [PHONE_B]: false });

    const result = await reserveVariations([PHONE_A, PHONE_B], "checkout-3");

    expect(result.ok).toBe(false);
    expect(SingleVariation.updateMany).toHaveBeenCalledWith(
      { reservedFor: "checkout-3" },
      { $set: { reservedUntil: null, reservedFor: null } }
    );
  });

  it("lets a checkout re-take a device it is already holding", async () => {
    claimReturns({});

    await reserveVariations([PHONE_A], "checkout-1");

    // A customer who reloads the checkout page must not be blocked by their
    // own reservation.
    const [filter] = SingleVariation.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toContainEqual({ reservedFor: "checkout-1" });
  });

  it("treats an expired hold as free", async () => {
    claimReturns({});

    await reserveVariations([PHONE_A], "checkout-9");

    // Time-based, so a crash or a closed tab cannot lock stock away forever.
    const [filter] = SingleVariation.findOneAndUpdate.mock.calls[0];
    const expiryClause = filter.$or.find((clause) => clause.reservedUntil?.$lt);
    expect(expiryClause.reservedUntil.$lt).toBeInstanceOf(Date);
  });
});

describe("releasing a hold", () => {
  it("frees everything that checkout was holding", async () => {
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 2 });

    expect(await releaseReservation("checkout-1")).toBe(2);
  });

  it("does nothing without a holder rather than freeing everything", async () => {
    expect(await releaseReservation(undefined)).toBe(0);
    expect(SingleVariation.updateMany).not.toHaveBeenCalled();
  });
});

describe("taking a device off sale once paid", () => {
  it("marks the devices sold and clears the hold", async () => {
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await markSold([PHONE_A, PHONE_B]);

    expect(SingleVariation.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [PHONE_A, PHONE_B] }, isAccessory: { $ne: true } },
      { $set: { outOfStock: true, reservedUntil: null, reservedFor: null } }
    );
  });

  it("does nothing for an empty list", async () => {
    await markSold([]);
    expect(SingleVariation.updateMany).not.toHaveBeenCalled();
  });

  it("leaves accessories on sale", async () => {
    // Cases and screen protectors are stocked in quantity. Taking one off sale
    // because somebody bought one would empty the shelf after a single order.
    await markSold([PHONE_A, CASE]);

    const [filter] = SingleVariation.updateMany.mock.calls[0];
    expect(filter.isAccessory).toEqual({ $ne: true });
  });
});

describe("accessories are not held like devices", () => {
  // Every device is one physical unit, so it is reserved for the customer who
  // reached checkout first. An accessory is not: holding the one Clear Case row
  // for one customer would stop everybody else buying a case at all.
  const onlyPhoneIsStockable = () => {
    SingleVariation.find.mockImplementation(() => ({
      select: () => ({ lean: async () => [{ _id: PHONE_A }] }),
    }));
  };

  it("claims the device and leaves the accessory alone", async () => {
    onlyPhoneIsStockable();
    claimReturns({});

    const result = await reserveVariations([PHONE_A, CASE], "checkout-4");

    expect(result.ok).toBe(true);
    expect(SingleVariation.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(SingleVariation.findOneAndUpdate.mock.calls[0][0]._id).toBe(PHONE_A);
  });

  it("asks only for stock-controlled rows", async () => {
    onlyPhoneIsStockable();
    claimReturns({});

    await reserveVariations([PHONE_A, CASE], "checkout-5");

    const [filter] = SingleVariation.find.mock.calls[0];
    expect(filter.isAccessory).toEqual({ $ne: true });
  });

  it("succeeds for a cart of accessories alone", async () => {
    SingleVariation.find.mockImplementation(() => ({
      select: () => ({ lean: async () => [] }),
    }));
    claimReturns({});

    const result = await reserveVariations([CASE], "checkout-6");

    expect(result.ok).toBe(true);
    expect(SingleVariation.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("reading device ids off an order", () => {
  it("picks out the product ids and skips the shipping line", async () => {
    const order = {
      line_items: [
        { price_data: { product_data: { metadata: { productId: PHONE_A } } } },
        { price_data: { product_data: { name: "Priority Shipping", metadata: { totalPaid: 10.5 } } } },
        { price_data: { product_data: { metadata: { productId: PHONE_B } } } },
      ],
    };

    expect(variationIdsFromOrder(order)).toEqual([PHONE_A, PHONE_B]);
  });

  it("returns nothing for an order with no line items", () => {
    expect(variationIdsFromOrder({})).toEqual([]);
    expect(variationIdsFromOrder(null)).toEqual([]);
  });
});

describe("holding a device while the bank reviews the payment", () => {
  it("pushes the hold well past the twenty-minute checkout window", async () => {
    // Simply not releasing is not enough. The ordinary hold expires on its own,
    // so a review lasting longer than twenty minutes would put the device back
    // on sale while the customer may still be charged for it.
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const before = Date.now();
    await holdForReview("checkout-1");

    const [filter, update] = SingleVariation.updateMany.mock.calls[0];
    expect(filter).toEqual({ reservedFor: "checkout-1" });

    const until = update.$set.reservedUntil.getTime();
    expect(until).toBeGreaterThan(before + HOLD_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + REVIEW_HOLD_MS);
  });

  it("keeps the holder, so the hold can still be released later", async () => {
    // A review ends in a decline as often as an accept, and releasing works by
    // matching reservedFor. Clearing it here would strand the device.
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await holdForReview("checkout-1");

    const [, update] = SingleVariation.updateMany.mock.calls[0];
    expect(update.$set).not.toHaveProperty("reservedFor");
  });

  it("does not mark anything sold — a review can still be refused", async () => {
    SingleVariation.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await holdForReview("checkout-1");

    const [, update] = SingleVariation.updateMany.mock.calls[0];
    expect(update.$set).not.toHaveProperty("outOfStock");
  });

  it("does nothing without a holder rather than holding everything", async () => {
    expect(await holdForReview(undefined)).toBe(0);
    expect(SingleVariation.updateMany).not.toHaveBeenCalled();
  });
});
