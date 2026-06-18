const router = require("express").Router();
const { wholesaleFormSubmit } = require("../controllers/wholesale.controller");

router.post("/", wholesaleFormSubmit);

module.exports = router;
