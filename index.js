require("dotenv").config();

const express = require("express");
const { Resend } = require("resend");
const cors = require("cors");
const indexRouter = require("./routes/index");
const { verifyToken } = require("./middleware/authMiddleware");
const { validateRequest } = require("./middleware/validate");
const { categorySchema, productSchema, orderSchema } = require("./middleware/schemas");
const { stripeCheckout, stripeWebhook } = require("./controllers/stripe");
const { makeOrderObjAndTotal } = require("./checkout-customer/controllers/checkout");

const app = express();

const authorizedOrigins = [
  "http://localhost:5173", // Local dev
  process.env.FRONTEND_URL, // Production
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || authorizedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

const { connectToDb, disconnectDb } = require("./database");
const ParentProduct = require("./schema/parentProduct");
const SingleVariation = require("./schema/singleVariation");
const Order = require("./schema/order");
const AvailableCatagories = require("./schema/availableCatagories");
const AddForm = require("./schema/addForm");
const ShopCategory = require("./schema/shopCategory");
const { SHOP_CATEGORY_DEFAULTS } = require("./constants/shopCategoryDefaults");

const resend = new Resend(process.env.RESEND_KEY);

// using middle ware to access raw body
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(indexRouter);

connectToDb();

async function ensureShopCategories() {
  const existing = await ShopCategory.find().lean();
  const existingNames = new Set(existing.map((item) => item.modelName));
  const missing = SHOP_CATEGORY_DEFAULTS.filter((item) => !existingNames.has(item.modelName));

  if (missing.length) {
    await ShopCategory.insertMany(missing);
  }
}

// when asked for all catagories
app.get("/catagory", async (req, res, next) => {
  try {
    const product = await ParentProduct.find();
    res.json(product);
  } catch (error) {
    next(error);
  }
});

app.get("/shop-categories", async (req, res, next) => {
  try {
    await ensureShopCategories();
    const categories = await ShopCategory.find().sort({ modelName: 1 });
    res.json(categories);
  } catch (error) {
    next(error);
  }
});

//getting availableCatagories
app.get("/available-catagories", async (req, res, next) => {
  try {
    const availableCatagories = await AvailableCatagories.find();
    res.status(200).json(availableCatagories);
  } catch (error) {
    next(error);
  }
});

// making available catagories
app.get("/mka", verifyToken, async (req, res, next) => {
  try {
    const ctg = new AvailableCatagories({ categories: [] });
    await ctg.save();
    res.status(200).json(ctg);
  } catch (error) {
    next(error);
  }
});

// when creating parent model
app.post("/catagory", verifyToken, validateRequest(categorySchema), async (req, res, next) => {
  const { modelName, description, images } = req.body;

  try {
    const newProduct = new ParentProduct({ modelName, description, images });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (error) {
    next(error);
  }
});

app.post("/shop-categories", verifyToken, validateRequest(categorySchema), async (req, res, next) => {
  const { modelName, description, images } = req.body;

  try {
    const created = await ShopCategory.findOneAndUpdate(
      { modelName },
      { modelName, description, images },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

// edit catagory
app.patch("/catagory/:id", verifyToken, validateRequest(categorySchema.partial()), (req, res, next) => {
  const id = req.params.id;
  const update = req.body;

  ParentProduct.findByIdAndUpdate(id, update)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

app.patch("/shop-categories/:id", verifyToken, validateRequest(categorySchema.partial()), (req, res, next) => {
  const id = req.params.id;
  const update = req.body;

  ShopCategory.findByIdAndUpdate(id, update, { new: true })
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

//delete a catagory
app.delete("/catagory/:id", verifyToken, (req, res, next) => {
  const id = req.params.id;
  ParentProduct.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

app.delete("/shop-categories/:id", verifyToken, (req, res, next) => {
  const id = req.params.id;
  ShopCategory.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

// this part is for product
// get all products
app.get("/product", async (req, res) => {
  const allProduct = await SingleVariation.find();
  res.json(allProduct);
});

//get single product
app.get("/product/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const product = await SingleVariation.findById(id);
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
});

app.get("/order/:id", async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
});

// get all products of same parent catagory
app.get("/allSameParentProducts/:parentId", async (req, res, next) => {
  try {
    const id = req.params.parentId;
    const product = await SingleVariation.find({ parentCatagory: id });
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
});

//get products with search terms
app.get("/searchproducts", async (req, res, next) => {
  const query = req.query.search;

  if (!query) return res.status(200).json([]);

  const searchTerms = query.split(" ");

  try {
    const filterredWord = searchTerms
      .filter((word) => !/^iphone$/i.test(word))
      .join(" ");

    // Escape special regex characters to prevent ReDoS
    const escaped = filterredWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const result = await SingleVariation.find({
      $or: [{ productName: { $regex: regex } }],
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

//get first n products, ex: 12 with skip: 0
app.post("/products/:n/:skip", async (req, res, next) => {
  try {
    const n = req.params.n;
    const skip = req.params.skip;

    const { productName, storage, color, price, condition } = req.body;

    const searchQuery = {
      productName: productName.length
        ? { $in: productName }
        : { $exists: true },
      storage: storage.length ? { $in: storage } : { $exists: true },
      "color.name": color.length ? { $in: color } : { $exists: true },
      condition: condition.length ? { $in: condition } : { $exists: true },
      price: { $gte: price[0], $lte: price[1] },
    };

    // console.log("server query: ", searchQuery)

    const products = await SingleVariation.find(searchQuery)
      .skip(skip)
      .limit(n);
    // const products = await SingleVariation.find(searchQuery)

    if (products.length) {
      // console.log("products present")
      // console.log("products present : ", products)
    }
    res.json(products);
  } catch (error) {
    next(error);
  }
});

//make a product
app.post("/product", verifyToken, validateRequest(productSchema), async (req, res, next) => {
  try {
    let product = req.body;
    const newProduct = new SingleVariation(product);
    await newProduct.save();

    // atomically add modelname to available categories (avoids read-modify-write race)
    const act = await AvailableCatagories.find();
    const idCtg = act[0]._id;
    await AvailableCatagories.findByIdAndUpdate(idCtg, {
      $addToSet: { categories: newProduct.productName },
    });

    res.status(200).json(newProduct);
  } catch (error) {
    next(error);
  }
});

// edit product
app.patch("/product/:id", verifyToken, validateRequest(productSchema.partial()), (req, res, next) => {
  const id = req.params.id;
  const update = req.body;

  SingleVariation.findByIdAndUpdate(id, update)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

app.delete("/product/:id", verifyToken, (req, res, next) => {
  const id = req.params.id;

  SingleVariation.findByIdAndDelete(id)
    .then((result) => res.status(200).json(result))
    .catch((error) => next(error));
});

// get cart products form front end
app.post("/cart", async (req, res, next) => {
  try {
    const { ids } = req.body;
    const products = await SingleVariation.find({ _id: { $in: ids || [] } });
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
});

//get all orders based on different catagory
app.get("/admin-orders/:status", verifyToken, async (req, res, next) => {
  const status = req.params.status;

  try {
    let orders = [];

    if (status.startsWith("byEmail") || status.startsWith("byOrderId")) {
      const [method, value] = status.split(":");
      if (method === "byEmail") {
        orders = await Order.find({ email: value }).sort({ updatedAt: -1 });
      } else {
        orders = [await Order.findById(value)];
      }
    } else {
      // get order from latest to old
      orders = await Order.find({ status }).sort({ updatedAt: -1 });
    }

    res.json(orders);
  } catch (error) {
    next(error);
  }
});

//get all orders based on data: today, this week and this month

app.get("/admin-orders-by-data", verifyToken, async (req, res, next) => {
  try {
    const now = new Date();

    const thisDay = new Date(now);
    thisDay.setHours(0, 0, 0, 0);

    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    thisWeekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const [tDay, tWeek, tMonth] = await Promise.all([
      Order.find({ createdAt: { $gte: thisDay } }),
      Order.find({ createdAt: { $gte: thisWeekStart } }),
      Order.find({ createdAt: { $gte: monthStart, $lt: monthEnd } }),
    ]);

    res.status(200).json({ today: tDay, thisWeek: tWeek, thisMonth: tMonth });
  } catch (error) {
    next(error);
  }
});

app.post("/update-order-status", verifyToken, async (req, res, next) => {
  const { orderId, status } = req.body;

  try {
    const order = await Order.findById(orderId);
    order.status = status;

    await order.save();

    const clientEmail = order?.email;

    // sending emails to globaltradersww2@gmail.com to confirm order
    await resend.emails.send({
      from: "GT <orders-update@globaltraders-usa.com>",
      to: [clientEmail],
      subject: `Order status changed to ${status}`,
      html: `<strong>Your order status updated!</strong> </br> <p> Your order with Order_Id:  <span style="color:blue">${order._id}</span>, status updated to <strong> ${status} </strong> </p> </br> <small> Thank you for staying with GlobalTraders </small>`,
    });

    res.send("success");
  } catch (error) {
    next(error);
  }
});

// get all order of a single client
app.get("/client-orders/:email", verifyToken, async (req, res, next) => {
  const email = req.params.email;

  try {
    const orders = await Order.find({ email, paid: true }).sort({
      updatedAt: -1,
    });
    res.json(orders);
  } catch (error) {
    next(error);
  }
});

app.post("/orders", validateRequest(orderSchema), async (req, res, next) => {
  try {
    const paidWith = req.body.paidWith || "Card";
    const { order } = await makeOrderObjAndTotal({ req, paidWith });
    order.paid = true;
    order.status = "Processing";

    const newOrder = await Order.create(order);
    res.status(201).json(newOrder);
  } catch (error) {
    next(error);
  }
});

// get one representative product per category
app.get("/all-products-single-variation", async (req, res, next) => {
  try {
    const availCatagoriesData = await AvailableCatagories.find();
    if (!availCatagoriesData.length) return res.status(200).json([]);
    const { categories } = availCatagoriesData[0];

    // one query with $in instead of N sequential queries
    const allMatches = await SingleVariation.find({ productName: { $in: categories } }).lean();

    // keep one representative per category, preserving category order
    const products = categories
      .map((name) => allMatches.find((p) => p.productName === name))
      .filter(Boolean);

    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
});

// stripe checkout
app.post("/checkout-stripe", validateRequest(orderSchema), stripeCheckout);

// stripe webhook - needs raw body
app.post("/stripe-webhook", stripeWebhook);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Global Error Handler:", err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Internal Server Error",
    details: err.details || null,
  });
});


const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log("server is running on port, ", port);
});
