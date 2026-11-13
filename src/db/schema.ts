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
  date,
  time,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------- Roles ----------

// Lowest to highest privilege. Lives in a real Postgres enum; adding a role
// later is a migration. What each role may do is NOT stored here: it is the
// single permission map in src/lib/permissions.ts.
export const ROLES = ["staff", "manager", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const userRole = pgEnum("user_role", ROLES);

// A scan opens a provisional (pending) session. It becomes open only when
// staff confirm the first order, and it stays non-closed until staff close the
// table or the idle-timeout job closes it.
export const TABLE_SESSION_STATUSES = ["pending", "open", "closed"] as const;
export type TableSessionStatus = (typeof TABLE_SESSION_STATUSES)[number];
export const tableSessionStatus = pgEnum(
  "table_session_status",
  TABLE_SESSION_STATUSES,
);

// Why a session ended. Staff closes are attributed to a user; timeouts are
// system actions. A future hard-delete of the user leaves closed_by = staff
// with a null user reference, so the reason is never lost.
export const TABLE_SESSION_CLOSED_BY = ["staff", "timeout"] as const;
export type TableSessionClosedBy = (typeof TABLE_SESSION_CLOSED_BY)[number];
export const tableSessionClosedBy = pgEnum(
  "table_session_closed_by",
  TABLE_SESSION_CLOSED_BY,
);

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

    // Issuing fingerprint until first rotation, then the consuming fingerprint.
    // Grace-window replays must match the client that first consumed the token.
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

// ---------- Shop settings ----------

// Key/value pairs rather than a singleton row: the spec models Setting as
// key/value, and new operational limits can be added without a migration.
// Values are stored as text and parsed/validated by the settings API. Defaults
// are inserted by migration 0005 so every database starts in a valid state.
export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("settings_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check(
      "settings_value_length_check",
      sql`char_length(${table.value}) between 0 and 1000`,
    ),
  ],
);

export type Setting = typeof settings.$inferSelect;

// Weekly recurring hours. day_of_week follows JavaScript: 0 = Sunday, 6 =
// Saturday. Times use the shop timezone (Asia/Manila) and are NOT timestamptz.
// The shop has no overnight hours, so close_time must be later than open_time.
export const storeHours = pgTable(
  "store_hours",
  {
    id: serial("id").primaryKey(),
    dayOfWeek: integer("day_of_week").notNull(),
    openTime: time("open_time"),
    closeTime: time("close_time"),
    closed: boolean("closed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One schedule row per weekday.
    uniqueIndex("store_hours_day_of_week_idx").on(table.dayOfWeek),
    check(
      "store_hours_day_of_week_check",
      sql`${table.dayOfWeek} between 0 and 6`,
    ),
    check(
      "store_hours_times_check",
      sql`(${table.closed} and ${table.openTime} is null and ${table.closeTime} is null)
        or (not ${table.closed} and ${table.openTime} is not null
          and ${table.closeTime} is not null
          and ${table.closeTime} > ${table.openTime})`,
    ),
  ],
);

export type StoreHour = typeof storeHours.$inferSelect;

// A date-specific override of the weekly schedule, for holidays or special
// hours. The date is a calendar date in the shop timezone, not an instant.
export const holidayOverrides = pgTable(
  "holiday_overrides",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull(),
    openTime: time("open_time"),
    closeTime: time("close_time"),
    closed: boolean("closed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("holiday_overrides_date_idx").on(table.date),
    check(
      "holiday_overrides_times_check",
      sql`(${table.closed} and ${table.openTime} is null and ${table.closeTime} is null)
        or (not ${table.closed} and ${table.openTime} is not null
          and ${table.closeTime} is not null
          and ${table.closeTime} > ${table.openTime})`,
    ),
  ],
);

export type HolidayOverride = typeof holidayOverrides.$inferSelect;

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
export const shopTables = pgTable(
  "shop_tables",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    qrToken: text("qr_token").notNull().unique(),
    orderLimit: integer("order_limit").notNull().default(5),
    active: boolean("active").notNull().default(true),
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
      "shop_tables_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check("shop_tables_order_limit_check", sql`${table.orderLimit} > 0`),
    check(
      "shop_tables_token_check",
      sql`${table.qrToken} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    index("shop_tables_active_id_idx").on(table.active, table.id),
  ],
);

export type ShopTable = typeof shopTables.$inferSelect;

// One visit to a physical table. A scan creates a pending session so the shared
// cart survives refreshes; started_at is set when staff confirm the first order
// and the session becomes open. Only one non-closed session may exist per table.
export const tableSessions = pgTable(
  "table_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tableId: integer("table_id")
      .notNull()
      .references(() => shopTables.id, { onDelete: "restrict" }),
    status: tableSessionStatus("status").notNull().default("pending"),
    // When the provisional session was created by a QR scan.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // When the session actually opened (first order confirmed). NULL while
    // pending, and NULL for a provisional session closed with no orders.
    startedAt: timestamp("started_at", { withTimezone: true }),
    // Updated by new orders, status changes, and cart edits; the idle-timeout
    // job closes sessions whose last activity is older than the setting.
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: tableSessionClosedBy("closed_by"),
    // Set for staff closes. onDelete set null preserves session history if a
    // user is ever hard-deleted.
    closedByUserId: integer("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    // "A table can only have one current session" is enforced by the database,
    // not just by the application, so concurrent scans cannot create two.
    uniqueIndex("table_sessions_non_closed_table_idx")
      .on(table.tableId)
      .where(sql`${table.status} <> 'closed'`),
    index("table_sessions_status_activity_idx").on(
      table.status,
      table.lastActivityAt,
    ),
    check(
      "table_sessions_started_check",
      sql`(${table.status} <> 'pending' or ${table.startedAt} is null)
        and (${table.status} <> 'open' or ${table.startedAt} is not null)`,
    ),
    check(
      "table_sessions_closed_check",
      sql`case when ${table.status} = 'closed'
        then ${table.closedAt} is not null and ${table.closedBy} is not null
        else ${table.closedAt} is null and ${table.closedBy} is null
          and ${table.closedByUserId} is null
      end`,
    ),
    check(
      "table_sessions_staff_close_check",
      sql`${table.closedBy} is distinct from 'staff' or ${table.closedByUserId} is not null`,
    ),
    check(
      "table_sessions_timeout_close_check",
      sql`${table.closedBy} is distinct from 'timeout' or ${table.closedByUserId} is null`,
    ),
  ],
);

export type TableSession = typeof tableSessions.$inferSelect;
export type NewTableSession = typeof tableSessions.$inferInsert;

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

// A group may be single-choice (max 1, e.g. Temperature) or multi-select
// (e.g. add-ons). min_selections > 0 means the customer must choose at least
// that many. required is kept as the public-menu flag and is always true
// exactly when min_selections is at least 1; the check below keeps them in sync.
export const menuOptionGroups = pgTable(
  "menu_option_groups",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    required: boolean("required").notNull().default(false),
    minSelections: integer("min_selections").notNull().default(0),
    maxSelections: integer("max_selections").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    check(
      "menu_option_groups_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 100`,
    ),
    check("menu_option_groups_order_check", sql`${table.sortOrder} >= 0`),
    check(
      "menu_option_groups_selections_check",
      sql`${table.minSelections} >= 0 and ${table.maxSelections} >= 1
        and ${table.minSelections} <= ${table.maxSelections}`,
    ),
    check(
      "menu_option_groups_required_check",
      sql`${table.required} = (${table.minSelections} >= 1)`,
    ),
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

// ---------- Shared table carts ----------

// Exactly one cart per table session. The cart row itself is the concurrency
// boundary: every item mutation bumps version inside the same transaction and
// clients send the version they last saw. A session close deletes the cart
// (the session row is kept for history).
export const carts = pgTable(
  "carts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tableSessionId: uuid("table_session_id")
      .notNull()
      .unique()
      .references(() => tableSessions.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [check("carts_version_check", sql`${table.version} >= 0`)],
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

// A line in the shared cart. Prices are NOT snapshotted here: the cart always
// shows current menu prices, and the order snapshots them at placement.
export const cartItems = pgTable(
  "cart_items",
  {
    id: serial("id").primaryKey(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    menuItemId: integer("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    // Free-text line note (e.g. "no sugar"). The order copies this at placement.
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("cart_items_quantity_check", sql`${table.quantity} between 1 and 99`),
    check(
      "cart_items_note_length_check",
      sql`char_length(${table.note}) <= 500`,
    ),
    index("cart_items_cart_idx").on(table.cartId, table.id),
  ],
);

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

// Selected add-ons/options for one cart line. The unique key prevents the same
// option from being selected twice on the same line.
export const cartItemOptions = pgTable(
  "cart_item_options",
  {
    id: serial("id").primaryKey(),
    cartItemId: integer("cart_item_id")
      .notNull()
      .references(() => cartItems.id, { onDelete: "cascade" }),
    optionId: integer("option_id")
      .notNull()
      .references(() => menuOptions.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("cart_item_options_unique_idx").on(
      table.cartItemId,
      table.optionId,
    ),
  ],
);

export type CartItemOption = typeof cartItemOptions.$inferSelect;
export type NewCartItemOption = typeof cartItemOptions.$inferInsert;

// ---------- Orders ----------

// The status values from specs.md section 4. "pending_confirmation" only ever
// belongs to an order placed before the table session is open; confirming it
// opens the session. "rejected" is only for a first order that staff rejected
// or that expired unconfirmed.
export const ORDER_STATUSES = [
  "pending_confirmation",
  "received",
  "preparing",
  "ready",
  "served",
  "cancelled",
  "rejected",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatus = pgEnum("order_status", ORDER_STATUSES);

// Payment is separate from the order lifecycle: a cancelled order can still be
// Paid, and a Served order can still be Unpaid.
export const PAYMENT_STATUSES = ["unpaid", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const orderPaymentStatus = pgEnum(
  "order_payment_status",
  PAYMENT_STATUSES,
);

// The spec records the method staff took at the counter. There is no online
// payment, so these are the only two choices.
export const PAYMENT_METHODS = ["cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const orderPaymentMethod = pgEnum(
  "order_payment_method",
  PAYMENT_METHODS,
);

// Who cancelled. Staff cancellations always carry a reason; customer
// cancellations do not need one.
export const ORDER_CANCELLED_BY = ["customer", "staff"] as const;
export type OrderCancelledBy = (typeof ORDER_CANCELLED_BY)[number];
export const orderCancelledBy = pgEnum(
  "order_cancelled_by",
  ORDER_CANCELLED_BY,
);

// One row per shop-local calendar day. Order numbers are YYYYMMDD-NNN, so the
// counter resets at local midnight and never repeats on the same day. The row
// is locked by the insert/upsert until the placing transaction commits.
export const orderNumberCounters = pgTable(
  "order_number_counters",
  {
    date: date("date", { mode: "string" }).primaryKey(),
    counter: integer("counter").notNull(),
  },
  (table) => [
    check("order_number_counters_counter_check", sql`${table.counter} > 0`),
  ],
);

export type OrderNumberCounter = typeof orderNumberCounters.$inferSelect;

// An order is a snapshotted cart. Names and prices are copied onto the lines so
// later menu edits never change what the customer ordered or what they owe.
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Human-facing number: shop-local date plus a daily counter.
    orderNumber: text("order_number").notNull().unique(),
    tableSessionId: uuid("table_session_id")
      .notNull()
      .references(() => tableSessions.id, { onDelete: "restrict" }),
    // Denormalized for table history and exports; the session keeps the
    // authoritative visit lifecycle.
    tableId: integer("table_id")
      .notNull()
      .references(() => shopTables.id, { onDelete: "restrict" }),
    status: orderStatus("status").notNull(),
    // Integer-centavo math is done in the API; these exact decimals are the
    // PHP amounts shown to the customer and stored for reporting.
    subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
    total: numeric("total", { precision: 10, scale: 2 }).notNull(),
    paymentStatus: orderPaymentStatus("payment_status")
      .notNull()
      .default("unpaid"),
    paymentMethod: orderPaymentMethod("payment_method"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByUserId: integer("paid_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Set when staff confirm a pending first order (which opens the session).
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

    // Customer cancellations can be requested without a reason; staff must
    // supply one. cancelledByUserId is null for customer cancellations.
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: orderCancelledBy("cancelled_by"),
    cancelledByUserId: integer("cancelled_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),

    // "expired" is written by the unconfirmed-order job. A staff rejection may
    // optionally include free text.
    rejectionReason: text("rejection_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("orders_session_created_idx").on(
      table.tableSessionId,
      table.createdAt,
      table.id,
    ),
    // The live board reads active statuses oldest first.
    index("orders_status_created_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    index("orders_table_created_idx").on(table.tableId, table.createdAt),
    check(
      "orders_order_number_check",
      sql`${table.orderNumber} ~ '^[0-9]{8}-[0-9]{3,}$'`,
    ),
    check(
      "orders_totals_check",
      sql`${table.subtotal} >= 0 and ${table.subtotal} <= 99999999.99
        and ${table.total} >= 0 and ${table.total} <= 99999999.99
        and ${table.total} = ${table.subtotal}`,
    ),
    // Paid means method and timestamp are both recorded. Unpaid means exactly
    // the opposite. paidByUserId may become null if that account is deleted.
    check(
      "orders_payment_check",
      sql`case when ${table.paymentStatus} = 'unpaid'
        then ${table.paymentMethod} is null and ${table.paidAt} is null
          and ${table.paidByUserId} is null
        else ${table.paymentMethod} is not null and ${table.paidAt} is not null
      end`,
    ),
    check(
      "orders_cancelled_check",
      sql`case when ${table.status} = 'cancelled'
        then ${table.cancelledAt} is not null and ${table.cancelledBy} is not null
        else ${table.cancelledAt} is null and ${table.cancelledBy} is null
          and ${table.cancelledByUserId} is null
          and ${table.cancellationReason} is null
      end`,
    ),
    check(
      "orders_staff_cancel_reason_check",
      sql`${table.cancelledBy} is distinct from 'staff'
        or ${table.cancellationReason} is not null`,
    ),
    check(
      "orders_cancellation_reason_length_check",
      sql`char_length(${table.cancellationReason}) <= 500`,
    ),
    check(
      "orders_rejection_check",
      sql`case when ${table.status} = 'rejected'
        then true
        else ${table.rejectionReason} is null
      end`,
    ),
    check(
      "orders_rejection_reason_length_check",
      sql`char_length(${table.rejectionReason}) <= 500`,
    ),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// One snapshot line per cart line. unitPriceSnapshot is the base menu price;
// lineTotal includes option deltas multiplied by quantity.
export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    menuItemId: integer("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "restrict" }),
    nameSnapshot: text("name_snapshot").notNull(),
    unitPriceSnapshot: numeric("unit_price_snapshot", {
      precision: 10,
      scale: 2,
    }).notNull(),
    quantity: integer("quantity").notNull(),
    note: text("note").notNull().default(""),
    lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  },
  (table) => [
    index("order_items_order_idx").on(table.orderId, table.id),
    check(
      "order_items_name_length_check",
      sql`char_length(btrim(${table.nameSnapshot})) between 1 and 100`,
    ),
    check(
      "order_items_unit_price_check",
      sql`${table.unitPriceSnapshot} >= 0
        and ${table.unitPriceSnapshot} <= 99999999.99`,
    ),
    check("order_items_quantity_check", sql`${table.quantity} between 1 and 99`),
    check(
      "order_items_note_length_check",
      sql`char_length(${table.note}) <= 500`,
    ),
    check(
      "order_items_line_total_check",
      sql`${table.lineTotal} >= 0 and ${table.lineTotal} <= 99999999.99`,
    ),
  ],
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

// Selected options are snapshotted too, including group and price delta.
export const orderItemOptions = pgTable(
  "order_item_options",
  {
    id: serial("id").primaryKey(),
    orderItemId: integer("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    optionId: integer("option_id")
      .notNull()
      .references(() => menuOptions.id, { onDelete: "restrict" }),
    nameSnapshot: text("name_snapshot").notNull(),
    groupNameSnapshot: text("group_name_snapshot").notNull(),
    priceDeltaSnapshot: numeric("price_delta_snapshot", {
      precision: 10,
      scale: 2,
    }).notNull(),
  },
  (table) => [
    uniqueIndex("order_item_options_unique_idx").on(
      table.orderItemId,
      table.optionId,
    ),
    check(
      "order_item_options_name_length_check",
      sql`char_length(btrim(${table.nameSnapshot})) between 1 and 100
        and char_length(btrim(${table.groupNameSnapshot})) between 1 and 100`,
    ),
    check(
      "order_item_options_price_check",
      sql`${table.priceDeltaSnapshot} >= 0
        and ${table.priceDeltaSnapshot} <= 99999999.99`,
    ),
  ],
);

export type OrderItemOption = typeof orderItemOptions.$inferSelect;
export type NewOrderItemOption = typeof orderItemOptions.$inferInsert;
