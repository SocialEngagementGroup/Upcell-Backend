const { EmailConfig } = require("../models/emailConfig.model");

async function fetchOrCreateConfig() {
  let config = await EmailConfig.findOne();
  if (!config) {
    config = await EmailConfig.create({});
  }
  return config;
}

async function getEmailConfig(req, res, next) {
  try {
    const config = await fetchOrCreateConfig();
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
}

async function updateEmailConfig(req, res, next) {
  try {
    const config = await fetchOrCreateConfig();
    const { tradeInAdminEmail, enableCustomerEmails, enableAdminEmails } = req.body;

    if (typeof tradeInAdminEmail === "string" && tradeInAdminEmail.trim()) {
      config.tradeInAdminEmail = tradeInAdminEmail.trim();
    }
    if (typeof enableCustomerEmails === "boolean") {
      config.enableCustomerEmails = enableCustomerEmails;
    }
    if (typeof enableAdminEmails === "boolean") {
      config.enableAdminEmails = enableAdminEmails;
    }

    await config.save();
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
}

module.exports = { getEmailConfig, updateEmailConfig };
