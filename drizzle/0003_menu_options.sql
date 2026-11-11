CREATE TABLE "menu_item_option_groups" (
	"menu_item_id" integer NOT NULL,
	"option_group_id" integer NOT NULL,
	CONSTRAINT "menu_item_option_groups_menu_item_id_option_group_id_pk" PRIMARY KEY("menu_item_id","option_group_id")
);
--> statement-breakpoint
CREATE TABLE "menu_option_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_option_groups_name_check" CHECK (char_length(btrim("menu_option_groups"."name")) between 1 and 100),
	CONSTRAINT "menu_option_groups_order_check" CHECK ("menu_option_groups"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menu_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"name" text NOT NULL,
	"price_delta" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_options_name_check" CHECK (char_length(btrim("menu_options"."name")) between 1 and 100),
	CONSTRAINT "menu_options_price_check" CHECK ("menu_options"."price_delta" >= 0 and "menu_options"."price_delta" <= 99999999.99),
	CONSTRAINT "menu_options_order_check" CHECK ("menu_options"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_option_group_id_menu_option_groups_id_fk" FOREIGN KEY ("option_group_id") REFERENCES "public"."menu_option_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_options" ADD CONSTRAINT "menu_options_group_id_menu_option_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."menu_option_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_options_group_order_idx" ON "menu_options" USING btree ("group_id","sort_order","id");