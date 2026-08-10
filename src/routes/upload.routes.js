const router = require("express").Router();
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { createUploadSignature } = require("../controllers/upload.controller");

router.post("/uploads/signature", verifyToken, requireAdmin, createUploadSignature);

module.exports = router;
