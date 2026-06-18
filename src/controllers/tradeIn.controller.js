const mongoose = require("mongoose");
const { TradeInRequest, tradeInStatusEnum } = require("../models/tradeInRequest.model");
const {
  getAdminListPagination,
  emptyPaginatedResponse,
  sendPaginatedResults,
} = require("../utils/pagination");

async function createTradeInRequest(req, res, next) {
  try {
    const request = await TradeInRequest.create(req.body);
    res.status(201).json(request);
  } catch (error) {
    next(error);
  }
}

async function getAdminTradeInRequests(req, res, next) {
  const status = req.params.status;
  const { page, limit, skip } = getAdminListPagination(req);

  try {
    if (status.startsWith("byEmail:")) {
      const email = status.replace("byEmail:", "");
      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { email },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (status.startsWith("byRequestId:")) {
      const id = status.replace("byRequestId:", "");
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return emptyPaginatedResponse({ res, page, limit });
      }

      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { _id: id },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    } else if (tradeInStatusEnum.includes(status)) {
      return sendPaginatedResults({
        res,
        model: TradeInRequest,
        query: { status },
        sort: { updatedAt: -1 },
        page,
        limit,
        skip,
      });
    }

    return sendPaginatedResults({
      res,
      model: TradeInRequest,
      query: {},
      sort: { updatedAt: -1 },
      page,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
  }
}

async function updateTradeInStatus(req, res, next) {
  const { status } = req.body;

  try {
    if (!tradeInStatusEnum.includes(status)) {
      return res.status(400).json({ error: "Invalid trade-in status" });
    }

    const updated = await TradeInRequest.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
}

async function deleteTradeInRequest(req, res, next) {
  try {
    const deleted = await TradeInRequest.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Trade-in request not found" });
    }

    res.status(200).json(deleted);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createTradeInRequest,
  getAdminTradeInRequests,
  updateTradeInStatus,
  deleteTradeInRequest,
};
