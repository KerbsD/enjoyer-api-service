import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { accountColumns } from "../../lib/accounts.ts";
import type { ListAccountsQuery } from "../../validators/accounts.ts";

const handleListAccounts = async (_req: Request, res: Response) => {
  // Placed here by validateListAccountsQuery (req.query is read-only in Express 5)
  const { role, active, search, limit, offset, sort, order } = res.locals
    .query as ListAccountsQuery;

  const filters: SQL[] = [];
  if (role) filters.push(eq(users.role, role));
  if (active !== undefined) filters.push(eq(users.active, active));
  if (search) {
    // Escape wildcards so the search term matches literally
    const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = or(ilike(users.name, term), ilike(users.email, term));
    if (match) filters.push(match);
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const sortColumn = sort === "name" ? users.name : users.createdAt;

  const [rows, [count]] = await Promise.all([
    db
      .select(accountColumns)
      .from(users)
      .where(where)
      .orderBy(
        order === "asc" ? asc(sortColumn) : desc(sortColumn),
        asc(users.id), // stable tiebreak
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(where),
  ]);

  const total = count?.total ?? 0;

  res.json({
    success: true,
    data: rows,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + rows.length < total,
    },
  });
};

export { handleListAccounts };
