import { asc, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { shopTables } from "../../db/schema.ts";
import { parseId } from "../../lib/helpers.ts";
import { newToken } from "../../lib/tokens.ts";
import { tableUrl, qrPng, qrSvg, printSheet } from "../../lib/tableQr.ts";
import type { ListTablesQuery } from "../../validators/tables.ts";

const missing = (res: Response) =>
  res.status(404).json({ success: false, message: "Table not found." });

const withUrl = (table: typeof shopTables.$inferSelect) => ({
  ...table,
  qrUrl: tableUrl(table.qrToken),
});
// Staff reads deliberately omit the QR token and URL.
export const tableColumns = {
  id: shopTables.id,
  name: shopTables.name,
  orderLimit: shopTables.orderLimit,
  active: shopTables.active,
  createdAt: shopTables.createdAt,
  updatedAt: shopTables.updatedAt,
};

export const createTable = async (req: Request, res: Response) => {
  const [table] = await db
    .insert(shopTables)
    .values({ ...req.body, qrToken: newToken() })
    .returning();
  if (!table) throw new Error("table insert returned no row");
  return res.status(201).json({ success: true, data: withUrl(table) });
};

export const getTable = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return missing(res);
  const [table] = await db
    .select()
    .from(shopTables)
    .where(eq(shopTables.id, id))
    .limit(1);
  return table
    ? res.json({ success: true, data: withUrl(table) })
    : missing(res);
};

export const updateTable = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return missing(res);
  const [table] = await db
    .update(shopTables)
    .set(req.body)
    .where(eq(shopTables.id, id))
    .returning();
  return table
    ? res.json({ success: true, data: withUrl(table) })
    : missing(res);
};

export const listTables =
  (admin: boolean) => async (_req: Request, res: Response) => {
    const { limit, offset, active } = res.locals.query as ListTablesQuery;
    const where =
      active === undefined ? undefined : eq(shopTables.active, active);
    const [rows, [count]] = await Promise.all([
      db
        .select(
          admin
            ? { ...tableColumns, qrToken: shopTables.qrToken }
            : tableColumns,
        )
        .from(shopTables)
        .where(where)
        .orderBy(asc(shopTables.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(shopTables)
        .where(where),
    ]);
    const total = count?.total ?? 0;
    return res.json({
      success: true,
      data: rows.map((row) =>
        "qrToken" in row
          ? { ...row, qrUrl: tableUrl(row.qrToken as string) }
          : row,
      ),
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + rows.length < total,
      },
    });
  };
export const downloadQr = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return missing(res);
  const [table] = await db
    .select()
    .from(shopTables)
    .where(eq(shopTables.id, id))
    .limit(1);
  if (!table) return missing(res);
  if (!table.active)
    return res.status(409).json({
      success: false,
      message: "Reactivate this table before downloading its QR code.",
    });
  const format = res.locals.query.format as "png" | "svg";
  res.attachment(`table-${id}.${format}`);
  return format === "svg"
    ? res.type("image/svg+xml").send(await qrSvg(table.qrToken))
    : res.type("image/png").send(await qrPng(table.qrToken));
};

export const downloadQrSheet = async (_req: Request, res: Response) => {
  const tables = await db
    .select({
      id: shopTables.id,
      name: shopTables.name,
      qrToken: shopTables.qrToken,
    })
    .from(shopTables)
    .where(eq(shopTables.active, true))
    .orderBy(asc(shopTables.id));
  res.attachment("enjoyer-table-qr-codes.html");
  return res.type("html").send(await printSheet(tables));
};
