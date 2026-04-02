require("dotenv").config();

const express = require("express");
const { Resend } = require("resend");
const cors = require("cors");
const indexRouter = require("./routes/index");
const { verifyToken } = require("./middleware/authMiddleware");
const { validateRequest } = require("./middleware/validate");
const { categorySchema, productSchema, orderSchema } = require("./middleware/schemas");
const { stripeCheckout, stripeWebhook } = require("./controllers/stripe");

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

// for firebase-function upload only
const functions = require("firebase-functions");

const { connectToDb, disconnectDb } = require("./database");
const ParentProduct = require("./schema/parentProduct");
const SingleVariation = require("./schema/singleVariation");
const Order = require("./schema/order");
const AvailableCatagories = require("./schema/availableCatagories");
const AddForm = require("./schema/addForm");

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

// when asked for all catagories
app.get("/catagory", async (req, res) => {

  const product = await ParentProduct.find();
  res.json(product);
});

//getting availableCatagories
app.get("/available-catagories", async (req, res) => {

  const availableCatagories = await AvailableCatagories.find();
  res.status(200).json(availableCatagories);
});

// making available catagories
app.get("/mka", async (req, res) => {
  try {
    // const  ctg = new AvailableCatagories({categories: ["iphone 8 plus", "iphone X","iphone XR","iphone XS","iphone 8"]})
    const ctg = new AvailableCatagories({ categories: [] });
    await ctg.save();

    res.status(200).json(ctg);
  } catch (error) {
    res.status(200).json(error);
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

// edit catagory
app.patch("/catagory/:id", verifyToken, validateRequest(categorySchema.partial()), (req, res, next) => {
  const id = req.params.id;
  const update = req.body;

  ParentProduct.findByIdAndUpdate(id, update)
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
app.get("/searchproducts", async (req, res) => {
  // simplify search parsing
  const query = req.query.search;

  // for multiple values take splited with " " space
  const searchTerms = query.split(" ");

  try {
    const filterredWord = searchTerms
      .filter((word) => !/^iphone$/i.test(word))
      .join(" ");

    // console.log(filterredWord);

    const regex = new RegExp(filterredWord, "i");

    const result = await SingleVariation.find({
      $or: [{ productName: { $regex: regex } }],
    });

    // const result = [];

    // for (const term of searchTerms) {
    //   // Check if the term is 'iphone' (case-insensitive) and skip it if true
    //   if (/^iphone$/i.test(term)) {
    //     continue;
    //   }

    //   console.log(term);

    //   const regex = new RegExp(term, "i");

    //   const products = await SingleVariation.find({
    //     $or: [
    //       { productName: { $regex: regex } },
    //       // { storage: { $regex: regex } },
    //       // { condition: { $regex: regex } },
    //     ],
    //   });

    //   result.push(...products);
    // }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

//get first n products, ex: 12 with skip: 0
app.post("/products/:n/:skip", async (req, res) => {
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

    // add the product modelname to available catagories
    const act = await AvailableCatagories.find();
    const category = act[0]?.categories;
    const idCtg = act[0]._id;

    if (!category.includes(newProduct.productName)) {
      category.push(newProduct.productName);
      await AvailableCatagories.findByIdAndUpdate(idCtg, {
        categories: category,
      });
    }

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
    const products = await SingleVariation.find({ _id: ids });
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

app.get("/admin-orders-by-data", verifyToken, async (req, res) => {
  try {
    const orders = {
      today: [],
      thisWeek: [],
      thisMonth: [],
    };

    // Get orders created today
    const thisDay = new Date();
    thisDay.setHours(0, 0, 0, 0);

    const tDay = await Order.find({ createdAt: { $gte: thisDay } });

    // Get orders created this week
    const thisWeekStart = new Date();
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay()); // Set to start of the week (Sunday)
    thisWeekStart.setHours(0, 0, 0, 0);

    const tWeek = await Order.find({ createdAt: { $gte: thisWeekStart } });

    // Get orders created this month
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    const tMonth = await Order.find({
      createdAt: { $gte: monthStart, $lt: monthEnd },
    });

    orders.today = tDay;
    orders.thisWeek = tWeek;
    orders.thisMonth = tMonth;

    res.status(200).json(orders);
  } catch (error) {
    next(error);
  }
});

app.post("/update-order-status", verifyToken, async (req, res) => {
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
app.get("/client-orders/:email", async (req, res, next) => {
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

// addrun getting all product once
app.get("/all-products-single-variation", async (req, res, next) => {
  try {
    const availCatagoriesData = await AvailableCatagories.find();
    if (!availCatagoriesData.length) return res.status(200).json([]);
    const { categories } = availCatagoriesData[0];

    const products = [];

    for (const productName of categories) {
      const product = await SingleVariation.findOne({ productName }).lean();
      if (product) {
        products.push(product);
      }
    }

    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
});

// warining sing to unwanted route
// app.use((req, res) => {
//     res.status(404).json({ error: "are you hacking ?" })
// })

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

// stripe checkout
app.post("/checkout-stripe", validateRequest(orderSchema), stripeCheckout);

// stripe webhook - needs raw body
app.post("/stripe-webhook", stripeWebhook);

// this part is for firebase
exports.app = functions.https.onRequest(app);
