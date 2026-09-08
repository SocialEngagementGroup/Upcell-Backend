const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");
const { monthlySellSchema } = require("../schemas/request.schemas");
const {
  getMonthlySell,
  setMonthlySell,
} = require("../controllers/monthlySell.controller");

router.get("/", getMonthlySell);
router.post("/", verifyToken, requireAdmin, validateRequest(monthlySellSchema), setMonthlySell);

module.exports = router;
