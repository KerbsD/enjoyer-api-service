import { z } from "zod";
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from "../db/schema.ts";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { booleanQueryField, paginationFields } from "./shared.ts";

const INT4_MAX = 2_147_483_647;

export const placeOrderSchema = z.strictObject({
  version: z.number().int().min(0),
});

export const listStaffOrdersQuerySchema = z.strictObject({
  status: z.enum(ORDER_STATUSES).optional(),
  tableId: z.coerce.number().int().min(1).max(INT4_MAX).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  // The live board hides cancelled/rejected orders by default. Managers can
  // still find them through order history in a later phase.
  includeCancelled: booleanQueryField("includeCancelled").optional(),
  ...paginationFields(100),
});

export const rejectOrderSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});

export const cancelOrderSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const markOrderPaidSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
});

export const closeTableSchema = z.strictObject({
  overrideUnpaid: z.boolean().default(false),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type ListStaffOrdersQuery = z.infer<typeof listStaffOrdersQuerySchema>;
export type RejectOrderInput = z.infer<typeof rejectOrderSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type MarkOrderPaidInput = z.infer<typeof markOrderPaidSchema>;
export type CloseTableInput = z.infer<typeof closeTableSchema>;

export const validatePlaceOrder = validateBody(placeOrderSchema);
export const validateListStaffOrders = validateQuery(listStaffOrdersQuerySchema);
export const validateRejectOrder = validateBody(rejectOrderSchema);
export const validateCancelOrder = validateBody(cancelOrderSchema);
export const validateMarkOrderPaid = validateBody(markOrderPaidSchema);
export const validateCloseTable = validateBody(closeTableSchema);
