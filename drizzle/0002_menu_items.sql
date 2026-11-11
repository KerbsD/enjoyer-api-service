CREATE TABLE "menu_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"is_spicy" boolean DEFAULT false NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_items_name_length_check" CHECK (char_length(btrim("menu_items"."name")) between 1 and 100),
	CONSTRAINT "menu_items_description_length_check" CHECK (char_length("menu_items"."description") <= 2000),
	CONSTRAINT "menu_items_price_check" CHECK ("menu_items"."price" >= 0 and "menu_items"."price" <= 99999999.99),
	CONSTRAINT "menu_items_sort_order_check" CHECK ("menu_items"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_items_category_order_idx" ON "menu_items" USING btree ("category_id","sort_order","id");