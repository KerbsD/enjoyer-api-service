CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_length_check" CHECK (char_length(btrim("categories"."name")) between 1 and 100),
	CONSTRAINT "categories_sort_order_check" CHECK ("categories"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX "categories_sort_order_id_idx" ON "categories" USING btree ("sort_order","id");