const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const {
  getMonthlySell,
  setMonthlySell,
} = require("../controllers/monthlySell.controller");

router.get("/", getMonthlySell);
router.post("/", verifyToken, requireAdmin, setMonthlySell);

module.exports = router;
