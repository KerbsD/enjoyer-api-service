CREATE TYPE "public"."table_session_closed_by" AS ENUM('staff', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."table_session_status" AS ENUM('pending', 'open', 'closed');--> statement-breakpoint
CREATE TABLE "cart_item_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"cart_item_id" integer NOT NULL,
	"option_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"menu_item_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_check" CHECK ("cart_items"."quantity" between 1 and 99),
	CONSTRAINT "cart_items_note_length_check" CHECK (char_length("cart_items"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_session_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_table_session_id_unique" UNIQUE("table_session_id"),
	CONSTRAINT "carts_version_check" CHECK ("carts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "holiday_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"open_time" time,
	"close_time" time,
	"closed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_overrides_times_check" CHECK (("holiday_overrides"."closed" and "holiday_overrides"."open_time" is null and "holiday_overrides"."close_time" is null)
        or (not "holiday_overrides"."closed" and "holiday_overrides"."open_time" is not null
          and "holiday_overrides"."close_time" is not null
          and "holiday_overrides"."close_time" > "holiday_overrides"."open_time"))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_check" CHECK ("settings"."key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "settings_value_length_check" CHECK (char_length("settings"."value") between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "store_hours" (
	"id" serial PRIMARY KEY NOT NULL,
	"day_of_week" integer NOT NULL,
	"open_time" time,
	"close_time" time,
	"closed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_hours_day_of_week_check" CHECK ("store_hours"."day_of_week" between 0 and 6),
	CONSTRAINT "store_hours_times_check" CHECK (("store_hours"."closed" and "store_hours"."open_time" is null and "store_hours"."close_time" is null)
        or (not "store_hours"."closed" and "store_hours"."open_time" is not null
          and "store_hours"."close_time" is not null
          and "store_hours"."close_time" > "store_hours"."open_time"))
);
--> statement-breakpoint
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" integer NOT NULL,
	"status" "table_session_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" "table_session_closed_by",
	"closed_by_user_id" integer,
	CONSTRAINT "table_sessions_started_check" CHECK (("table_sessions"."status" <> 'pending' or "table_sessions"."started_at" is null)
        and ("table_sessions"."status" <> 'open' or "table_sessions"."started_at" is not null)),
	CONSTRAINT "table_sessions_closed_check" CHECK (case when "table_sessions"."status" = 'closed'
        then "table_sessions"."closed_at" is not null and "table_sessions"."closed_by" is not null
        else "table_sessions"."closed_at" is null and "table_sessions"."closed_by" is null
          and "table_sessions"."closed_by_user_id" is null
      end),
	CONSTRAINT "table_sessions_staff_close_check" CHECK ("table_sessions"."closed_by" is distinct from 'staff' or "table_sessions"."closed_by_user_id" is not null),
	CONSTRAINT "table_sessions_timeout_close_check" CHECK ("table_sessions"."closed_by" is distinct from 'timeout' or "table_sessions"."closed_by_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD COLUMN "min_selections" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD COLUMN "max_selections" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Existing required groups were single-choice in the old model. Set the new
-- minimum before the required/minimum consistency constraint is added below.
UPDATE "menu_option_groups" SET "min_selections" = 1 WHERE "required" = true;--> statement-breakpoint
ALTER TABLE "cart_item_options" ADD CONSTRAINT "cart_item_options_cart_item_id_cart_items_id_fk" FOREIGN KEY ("cart_item_id") REFERENCES "public"."cart_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_item_options" ADD CONSTRAINT "cart_item_options_option_id_menu_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."menu_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_table_session_id_table_sessions_id_fk" FOREIGN KEY ("table_session_id") REFERENCES "public"."table_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_shop_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."shop_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_item_options_unique_idx" ON "cart_item_options" USING btree ("cart_item_id","option_id");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_overrides_date_idx" ON "holiday_overrides" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "store_hours_day_of_week_idx" ON "store_hours" USING btree ("day_of_week");--> statement-breakpoint
CREATE UNIQUE INDEX "table_sessions_non_closed_table_idx" ON "table_sessions" USING btree ("table_id") WHERE "table_sessions"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "table_sessions_status_activity_idx" ON "table_sessions" USING btree ("status","last_activity_at");--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_selections_check" CHECK ("menu_option_groups"."min_selections" >= 0 and "menu_option_groups"."max_selections" >= 1
        and "menu_option_groups"."min_selections" <= "menu_option_groups"."max_selections");--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_required_check" CHECK ("menu_option_groups"."required" = ("menu_option_groups"."min_selections" >= 1));--> statement-breakpoint
-- Operational defaults from specs.md section 6. ON CONFLICT keeps a rerun of
-- this migration safe if the rows were already added manually.
INSERT INTO "settings" ("key", "value") VALUES
	('idle_timeout_minutes', '180'),
	('confirmation_expiry_minutes', '10'),
	('shop_timezone', 'Asia/Manila')
ON CONFLICT ("key") DO NOTHING;
