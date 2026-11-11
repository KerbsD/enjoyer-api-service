import { ROLES } from "../db/schema.ts";
import type { Role } from "../db/schema.ts";

// Single source of truth for what each role may do (specs.md section 2).
//
// Roles are strictly nested (Owner > Manager > Staff), so each set is built on
// top of the one below it instead of being listed again. Counter staff,
// baristas and kitchen are all Staff: there is no counter-only role.
//
// Routes use this through requirePermission(...); handlers use can(...) for
// actions that share an endpoint with a lower role (for example undoing a
// status change, or overriding the unpaid-table warning when closing).
//
// Not covered yet because the spec has no detailed stories for them: pausing
// ordering, the activity log, and staff notifications. Add permissions for
// those when their stories exist, not before.

// Everything Staff can do.
const STAFF_PERMISSIONS = [
  "board:view", // live order board
  "table:view", // table overview and a table's orders
  "order:confirm", // confirm or reject a table's first order
  "order:advance", // move status forward, one step at a time
  "order:cancel", // cancel any order at any status (reason required)
  "order:mark-paid", // record payment and method
  "table:close", // close a table (blocked while orders are unpaid)
  "item:toggle-sold-out", // flip an item's availability
] as const;

// What Manager adds on top of Staff.
const MANAGER_PERMISSIONS = [
  "order:revert-status", // go back a step
  "table:close-override-unpaid", // close a table despite unpaid orders
  "menu:manage", // categories, items, add-ons, ordering, hiding
  "table:manage", // add, rename, deactivate tables; QR codes; order limit
  "settings:manage", // idle timeout, confirmation expiry
  "store-hours:manage", // per-day hours and holiday overrides
  "dashboard:view",
  "order-history:view",
  "export:run",
] as const;

// What Owner adds on top of Manager.
const OWNER_PERMISSIONS = [
  "account:manage", // create, change role, deactivate accounts
] as const;

export type Permission =
  | (typeof STAFF_PERMISSIONS)[number]
  | (typeof MANAGER_PERMISSIONS)[number]
  | (typeof OWNER_PERMISSIONS)[number];

const staff = new Set<Permission>(STAFF_PERMISSIONS);
const manager = new Set<Permission>([...staff, ...MANAGER_PERMISSIONS]);
const owner = new Set<Permission>([...manager, ...OWNER_PERMISSIONS]);

// Record<Role, ...> makes the compiler fail here if a role is added to ROLES
// without deciding its permissions.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  staff,
  manager,
  owner,
};

export const can = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].has(permission);

// For values read from outside the type system (a token claim, a request body)
export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value);
