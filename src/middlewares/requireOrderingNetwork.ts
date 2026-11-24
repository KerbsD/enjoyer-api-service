import type { RequestHandler } from "express";
import {
  orderingNetworkFailure,
  requestOrderingAddress,
} from "../lib/orderingNetwork.ts";

export const requireOrderingNetwork: RequestHandler = async (
  req,
  res,
  next,
) => {
  const failure = await orderingNetworkFailure(requestOrderingAddress(req));
  if (failure)
    return res.status(failure.status).json({ success: false, ...failure });
  next();
};
