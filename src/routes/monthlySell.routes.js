const router = require("express").Router();
const {
  getMonthlySell,
  setMonthlySell,
} = require("../controllers/monthlySell.controller");

router.get("/", getMonthlySell);
router.post("/", setMonthlySell);

module.exports = router;
