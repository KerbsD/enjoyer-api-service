import type { Request, Response } from "express";
import { db } from "../db/index.ts";
import { CURRENCY } from "../configs/currency.ts";
import { parseUuid } from "../lib/helpers.ts";
import { loadOrderView } from "../lib/orders.ts";
import { getDashboard, findHistoricalOrders, resolveDateRange, exportRangeOrders } from "../lib/reports.ts";
import { readShopSettings } from "../lib/settings.ts";
import type { DashboardQuery, ExportQuery, HistoryQuery } from "../validators/reports.ts";

export const dashboard = async (_req: Request, res: Response) => {
  const query = res.locals.query as DashboardQuery;
  const [settings, now] = [await readShopSettings(), new Date()];
  return res.json({
    success: true,
    currency: CURRENCY,
    data: await getDashboard(query, now, settings.shopTimezone),
  });
};

export const orderHistory = async (_req: Request, res: Response) => {
  const query = res.locals.query as HistoryQuery;
  const [settings, now] = [await readShopSettings(), new Date()];
  const range = query.from && query.to
    ? resolveDateRange({ from: query.from, to: query.to }, now, settings.shopTimezone)
    : undefined;
  const result = await findHistoricalOrders(query, range);
  return res.json({
    success: true,
    currency: CURRENCY,
    data: result.rows,
    pagination: result.pagination,
    ...(range ? { range: { from: range.from, to: range.to, timezone: settings.shopTimezone } } : {}),
  });
};

export const historicalOrderDetail = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id)
    return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND", message: "Order not found." });
  const order = await loadOrderView(id);
  return order
    ? res.json({ success: true, currency: CURRENCY, data: order })
    : res.status(404).json({ success: false, code: "ORDER_NOT_FOUND", message: "Order not found." });
};

// Quote every cell and neutralize spreadsheet formula prefixes. Snapshotted
// customer notes/item names are untrusted text even though current item names
// are validated: imported CSV should not execute a formula when opened.
export const csvCell = (value: unknown): string => {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

const csvRecord = (values: unknown[]) => `${values.map(csvCell).join(",")}\r\n`;
const EXPORT_BATCH_SIZE = 250;

const writeChunk = async (res: Response, chunk: string): Promise<boolean> => {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await new Promise<void>((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      res.off("close", finish);
      resolve();
    };
    res.once("drain", finish);
    res.once("close", finish);
  });
  return !res.destroyed && !res.writableEnded;
};

export const exportOrdersCsv = async (_req: Request, res: Response) => {
  const query = res.locals.query as ExportQuery;
  const settings = await readShopSettings();
  const range = resolveDateRange(query, new Date(), settings.shopTimezone);
  const filename = `enjoyer-orders-${range.from}-to-${range.to}.csv`;
  res.status(200).set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (!(await writeChunk(res, "\uFEFF" + csvRecord([
    "Order ID", "Order Number", "Time (UTC)", "Table", "Items", "Total (PHP)",
    "Payment Status", "Payment Method", "Cancelled",
  ])))) return;

  try {
    let offset = 0;
    while (true) {
      const rows = await exportRangeOrders(range, offset, EXPORT_BATCH_SIZE);
      for (const order of rows) {
        const itemText = order.items.map((item) => {
          const options = item.options.map((option) => option.name).join(" + ");
          const note = item.note ? ` — Note: ${item.note}` : "";
          return `${item.quantity} × ${item.name}${options ? ` (${options})` : ""}${note}`;
        }).join("; ");
        if (!(await writeChunk(res, csvRecord([
          order.id,
          order.orderNumber,
          order.createdAt,
          order.tableName,
          itemText,
          order.total,
          order.paymentStatus,
          order.paymentMethod,
          order.status === "cancelled",
        ])))) return;
      }
      if (rows.length < EXPORT_BATCH_SIZE) break;
      offset += rows.length;
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) throw error;
    res.destroy(error instanceof Error ? error : undefined);
  }
};
