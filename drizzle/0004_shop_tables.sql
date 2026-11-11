CREATE TABLE "shop_tables" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"qr_token" text NOT NULL,
	"order_limit" integer DEFAULT 5 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_tables_qr_token_unique" UNIQUE("qr_token"),
	CONSTRAINT "shop_tables_name_check" CHECK (char_length(btrim("shop_tables"."name")) between 1 and 100),
	CONSTRAINT "shop_tables_order_limit_check" CHECK ("shop_tables"."order_limit" > 0),
	CONSTRAINT "shop_tables_token_check" CHECK ("shop_tables"."qr_token" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE INDEX "shop_tables_active_id_idx" ON "shop_tables" USING btree ("active","id");