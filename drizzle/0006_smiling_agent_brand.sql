CREATE TYPE "public"."order_cancelled_by" AS ENUM('customer', 'staff');--> statement-breakpoint
CREATE TYPE "public"."order_payment_method" AS ENUM('cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."order_payment_status" AS ENUM('unpaid', 'paid');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_confirmation', 'received', 'preparing', 'ready', 'served', 'cancelled', 'rejected');--> statement-breakpoint
CREATE TABLE "order_item_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_item_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"name_snapshot" text NOT NULL,
	"group_name_snapshot" text NOT NULL,
	"price_delta_snapshot" numeric(10, 2) NOT NULL,
	CONSTRAINT "order_item_options_name_length_check" CHECK (char_length(btrim("order_item_options"."name_snapshot")) between 1 and 100
        and char_length(btrim("order_item_options"."group_name_snapshot")) between 1 and 100),
	CONSTRAINT "order_item_options_price_check" CHECK ("order_item_options"."price_delta_snapshot" >= 0
        and "order_item_options"."price_delta_snapshot" <= 99999999.99)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" integer NOT NULL,
	"name_snapshot" text NOT NULL,
	"unit_price_snapshot" numeric(10, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"line_total" numeric(10, 2) NOT NULL,
	CONSTRAINT "order_items_name_length_check" CHECK (char_length(btrim("order_items"."name_snapshot")) between 1 and 100),
	CONSTRAINT "order_items_unit_price_check" CHECK ("order_items"."unit_price_snapshot" >= 0
        and "order_items"."unit_price_snapshot" <= 99999999.99),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" between 1 and 99),
	CONSTRAINT "order_items_note_length_check" CHECK (char_length("order_items"."note") <= 500),
	CONSTRAINT "order_items_line_total_check" CHECK ("order_items"."line_total" >= 0 and "order_items"."line_total" <= 99999999.99)
);
--> statement-breakpoint
CREATE TABLE "order_number_counters" (
	"date" date PRIMARY KEY NOT NULL,
	"counter" integer NOT NULL,
	CONSTRAINT "order_number_counters_counter_check" CHECK ("order_number_counters"."counter" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"table_session_id" uuid NOT NULL,
	"table_id" integer NOT NULL,
	"status" "order_status" NOT NULL,
	"subtotal" numeric(10, 2) NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"payment_status" "order_payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_method" "order_payment_method",
	"paid_at" timestamp with time zone,
	"paid_by_user_id" integer,
	"confirmed_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "order_cancelled_by",
	"cancelled_by_user_id" integer,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_order_number_check" CHECK ("orders"."order_number" ~ '^[0-9]{8}-[0-9]{3,}$'),
	CONSTRAINT "orders_totals_check" CHECK ("orders"."subtotal" >= 0 and "orders"."subtotal" <= 99999999.99
        and "orders"."total" >= 0 and "orders"."total" <= 99999999.99
        and "orders"."total" = "orders"."subtotal"),
	CONSTRAINT "orders_payment_check" CHECK (case when "orders"."payment_status" = 'unpaid'
        then "orders"."payment_method" is null and "orders"."paid_at" is null
          and "orders"."paid_by_user_id" is null
        else "orders"."payment_method" is not null and "orders"."paid_at" is not null
      end),
	CONSTRAINT "orders_cancelled_check" CHECK (case when "orders"."status" = 'cancelled'
        then "orders"."cancelled_at" is not null and "orders"."cancelled_by" is not null
        else "orders"."cancelled_at" is null and "orders"."cancelled_by" is null
          and "orders"."cancelled_by_user_id" is null
          and "orders"."cancellation_reason" is null
      end),
	CONSTRAINT "orders_staff_cancel_reason_check" CHECK ("orders"."cancelled_by" is distinct from 'staff'
        or "orders"."cancellation_reason" is not null),
	CONSTRAINT "orders_cancellation_reason_length_check" CHECK (char_length("orders"."cancellation_reason") <= 500),
	CONSTRAINT "orders_rejection_check" CHECK (case when "orders"."status" = 'rejected'
        then true
        else "orders"."rejection_reason" is null
      end),
	CONSTRAINT "orders_rejection_reason_length_check" CHECK (char_length("orders"."rejection_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_option_id_menu_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."menu_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_session_id_table_sessions_id_fk" FOREIGN KEY ("table_session_id") REFERENCES "public"."table_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_shop_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."shop_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_options_unique_idx" ON "order_item_options" USING btree ("order_item_id","option_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "orders_session_created_idx" ON "orders" USING btree ("table_session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_table_created_idx" ON "orders" USING btree ("table_id","created_at");
