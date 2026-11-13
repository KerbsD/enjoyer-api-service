import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  carts, categories, holidayOverrides, menuItemOptionGroups, menuItems,
  menuOptionGroups, menuOptions, orders, settings, shopTables, storeHours,
  tableSessions,
} from "../../db/schema.ts";

export type RealtimeScope = { kind: "staff" } | {
  kind: "table";
  tableId: number;
  sessionId: string;
};
export type Revisions = Record<string, string>;
export type RevisionState = { revision: string; resources: Revisions };

// Fingerprints, not event sequence numbers. Reconnect always resynchronizes;
// intermediate states can coalesce. One SQL statement uses one MVCC snapshot,
// sees only committed changes, and works through transaction-mode poolers.
// Hash each row before aggregation so database-to-API results stay bounded.
const fingerprint = (table: SQL, key: SQL, where?: SQL): SQL => sql`(
  select md5(coalesce(string_agg(md5(to_jsonb(${table})::text), '' order by ${key}), ''))
  from ${table} ${where ? sql`where ${where}` : sql``}
)`;

export const revisionQuery = (scope: RealtimeScope): SQL => {
  const scoped = scope.kind === "table";
  const orderWhere = scoped ? sql`${orders.tableSessionId} = ${scope.sessionId}` : undefined;
  const sessionWhere = scoped ? sql`${tableSessions.id} = ${scope.sessionId}` : undefined;
  const tableWhere = scoped ? sql`${shopTables.id} = ${scope.tableId}` : undefined;
  const menu = sql`concat(
    ${fingerprint(sql`${categories}`, sql`${categories.id}`)},
    ${fingerprint(sql`${menuItems}`, sql`${menuItems.id}`)},
    ${fingerprint(sql`${menuOptionGroups}`, sql`${menuOptionGroups.id}`)},
    ${fingerprint(sql`${menuOptions}`, sql`${menuOptions.id}`)},
    ${fingerprint(sql`${menuItemOptionGroups}`, sql`(${menuItemOptionGroups.menuItemId}, ${menuItemOptionGroups.optionGroupId})`)}
  )`;
  const store = sql`concat(
    ${fingerprint(sql`${settings}`, sql`${settings.key}`)},
    ${fingerprint(sql`${storeHours}`, sql`${storeHours.id}`)},
    ${fingerprint(sql`${holidayOverrides}`, sql`${holidayOverrides.id}`)},
    to_char(current_timestamp at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
  )`;
  // Cart edits and placement bump version in the same transaction as lines.
  // Menu is a separate dependency: changing prices/availability also requires
  // a cart refresh even when its own version has not changed.
  return sql`select
    ${fingerprint(sql`${orders}`, sql`${orders.id}`, orderWhere)} as orders,
    md5(concat(
      ${fingerprint(sql`${tableSessions}`, sql`${tableSessions.id}`, sessionWhere)},
      ${fingerprint(sql`${shopTables}`, sql`${shopTables.id}`, tableWhere)}
    )) as tables,
    md5(${menu}) as menu,
    md5(${store}) as store
    ${scoped ? sql`, ${fingerprint(sql`${carts}`, sql`${carts.id}`, sql`${carts.tableSessionId} = ${scope.sessionId}`)} as cart` : sql``}
  `;
};

export const readRevisions = async (scope: RealtimeScope): Promise<RevisionState> => {
  const result = await db.execute(revisionQuery(scope));
  const row = result.rows[0] as Revisions | undefined;
  if (!row) throw new Error("Realtime revision query returned no row");
  const resources = Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
  return {
    revision: createHash("sha256").update(JSON.stringify(resources)).digest("hex"),
    resources,
  };
};

export const changedResources = (before: Revisions, after: Revisions): string[] =>
  Object.keys(after).filter((key) => before[key] !== after[key]);
