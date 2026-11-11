import {
  pgTable,
  pgEnum,
  serial,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
  uuid,
  integer,
  check,
  numeric,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------- Roles ----------

// Lowest to highest privilege. Lives in a real Postgres enum; adding a role
// later is a migration. What each role may do is NOT stored here: it is the
// single permission map in src/lib/permissions.ts.
export const ROLES = ["staff", "manager", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const userRole = pgEnum("user_role", ROLES);

// ---------- Users ----------

// Staff-side accounts only (Owner, Manager, Staff). Customers never log in, so
// they have no row here. Accounts are created by the Owner, never by public
// sign-up, so there is no email-verification step: the invite link itself
// proves the person controls the address.
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    // Login identifier. Uniqueness is enforced by the case-insensitive index
    // below; a plain .unique() here would be a redundant, looser constraint.
    email: text("email").notNull(),
    // NULL while an invite is pending: the account exists but cannot log in
    // until the person sets a password. Login always runs a bcrypt compare
    // against a dummy hash when this is NULL, so timing does not reveal it.
    password: text("password"),
    // No default on purpose: every insert must choose a role explicitly, so a
    // forgotten field can never silently create a privileged (or any) account.
    role: userRole("role").notNull(),
    // Accounts are deactivated, never deleted, so the activity log and past
    // orders can keep pointing at the person who did something. Deactivating
    // must also revoke the user's sessions (done in the account endpoint).
    active: boolean("active").notNull().default(true),

    // One token pair serves both flows that end in "set a password": the
    // invite sent when the Owner creates an account, and "forgot password".
    // Only SHA-256 hashes are stored; the raw token exists only in the email
    // link. The TTL is chosen when the token is issued (longer for invites).
    // .unique() also gives us the index for the atomic lookup.
    resetPasswordTokenHash: text("reset_password_token_hash").unique(),
    resetPasswordExpiresAt: timestamp("reset_password_expires_at", {
      withTimezone: true,
    }),
    resetPasswordSentAt: timestamp("reset_password_sent_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
    // Account list is small, but "who are the active owners" is checked on
    // every account change (the last active Owner must never be removed).
    index("users_role_active_idx").on(table.role, table.active),
  ],
);

// ---------- Sessions ----------

// One row per issued refresh token. All tokens descended from one login share a
// familyId, so a replayed (already-rotated) token can revoke the whole chain.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }), // set when rotated
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    // Fingerprint of the client this token was issued to. Lets the grace
    // window tell a multi-tab race apart from a replayed (stolen) token.
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_family_id_idx").on(table.familyId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;

// ---------- Menu categories ----------

export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "categories_name_length_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check("categories_sort_order_check", sql`${table.sortOrder} >= 0`),
    // Equal positions are allowed; id is the stable tiebreaker.
    index("categories_sort_order_id_idx").on(table.sortOrder, table.id),
  ],
);

export type Category = typeof categories.$inferSelect;

// Physical tables only. Sessions and order counts are a separate lifecycle.
export const shopTables = pgTable("shop_tables", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  qrToken: text("qr_token").notNull().unique(),
  orderLimit: integer("order_limit").notNull().default(5),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  check("shop_tables_name_check", sql`char_length(btrim(${table.name})) between 1 and 100`),
  check("shop_tables_order_limit_check", sql`${table.orderLimit} > 0`),
  check("shop_tables_token_check", sql`${table.qrToken} ~ '^[A-Za-z0-9_-]{43}$'`),
  index("shop_tables_active_id_idx").on(table.active, table.id),
]);

// ---------- Menu items ----------

export const menuItems = pgTable(
  "menu_items",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Drizzle returns exact decimal strings; never use floating-point money.
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    isSpicy: boolean("is_spicy").notNull().default(false),
    isAvailable: boolean("is_available").notNull().default(true),
    isHidden: boolean("is_hidden").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "menu_items_name_length_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check(
      "menu_items_description_length_check",
      sql`char_length(${table.description}) <= 2000`,
    ),
    check(
      "menu_items_price_check",
      sql`${table.price} >= 0 and ${table.price} <= 99999999.99`,
    ),
    check("menu_items_sort_order_check", sql`${table.sortOrder} >= 0`),
    index("menu_items_category_order_idx").on(
      table.categoryId,
      table.sortOrder,
      table.id,
    ),
  ],
);

export type MenuItem = typeof menuItems.$inferSelect;

// Each group offers one choice (optional or required). Multiple groups can be
// attached to an item, e.g. Temperature plus Milk substitution.
export const menuOptionGroups = pgTable(
  "menu_option_groups",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    check(
      "menu_option_groups_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check("menu_option_groups_order_check", sql`${table.sortOrder} >= 0`),
  ],
);

export const menuOptions = pgTable(
  "menu_options",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => menuOptionGroups.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    priceDelta: numeric("price_delta", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    check(
      "menu_options_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check(
      "menu_options_price_check",
      sql`${table.priceDelta} >= 0 and ${table.priceDelta} <= 99999999.99`,
    ),
    check("menu_options_order_check", sql`${table.sortOrder} >= 0`),
    index("menu_options_group_order_idx").on(
      table.groupId,
      table.sortOrder,
      table.id,
    ),
  ],
);

export const menuItemOptionGroups = pgTable(
  "menu_item_option_groups",
  {
    menuItemId: integer("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    optionGroupId: integer("option_group_id")
      .notNull()
      .references(() => menuOptionGroups.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.menuItemId, table.optionGroupId] })],
);
