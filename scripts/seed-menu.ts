import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import {
  categories,
  menuItems,
  menuOptionGroups,
  menuOptions,
  menuItemOptionGroups,
} from "../src/db/schema.ts";
import { createMenuItemSchema } from "../src/validators/menuItems.ts";
import { createOptionGroupSchema } from "../src/validators/menuOptions.ts";
import { menuSeed, optionGroupSeed } from "./data/enjoyer-menu.ts";

const key = (name: string) => name.trim().toLowerCase();
class SeedError extends Error {}
const one = <T>(rows: T[], label: string): T | undefined => {
  if (rows.length > 1)
    throw new SeedError(
      `Ambiguous existing name: ${label}. Nothing was changed.`,
    );
  return rows[0];
};
// Reuse identical entries; refuse to overwrite existing edits or a conflicting
// item silently. All changes are atomic. A rerun inserts no duplicates.
function same(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [field, value] of Object.entries(expected)) {
    if (field === "sortOrder") continue; // Preserve user-chosen ordering on reruns.
    if (existing[field] !== value)
      throw new SeedError(
        `Existing ${label} differs in ${field}. Nothing was changed.`,
      );
  }
}

try {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false } },
    strict: true,
  });
  // Validate the full manifest before connecting or writing.
  for (const group of optionGroupSeed) createOptionGroupSchema.parse(group);
  for (const category of menuSeed)
    for (const item of category.items) {
      const { groups, ...fields } = item;
      createMenuItemSchema.parse({ ...fields, categoryId: 1 });
      for (const name of groups ?? [])
        if (!optionGroupSeed.some((g) => g.name === name))
          throw new SeedError(`Unknown option group: ${name}`);
    }
  const counts = await db.transaction(async (tx) => {
    // Prevent API writes or another seed from racing name matching. No table
    // contents are deleted. This lock lasts only for this short transaction.
    await tx.execute(
      sql`lock table categories, menu_items, menu_option_groups, menu_options, menu_item_option_groups in share row exclusive mode`,
    );
    const existingCategories = await tx.select().from(categories);
    const existingItems = await tx.select().from(menuItems);
    const existingGroups = await tx.select().from(menuOptionGroups);
    const existingOptions = await tx.select().from(menuOptions);
    const existingLinks = await tx.select().from(menuItemOptionGroups);
    const count = { categories: 0, items: 0, groups: 0, options: 0, links: 0 };
    let virtualId = -1;
    const groupIds = new Map<string, number>();
    for (const { options, ...group } of optionGroupSeed) {
      let found = one(
        existingGroups.filter((g) => key(g.name) === key(group.name)),
        group.name,
      );
      if (found) same(found, group, group.name);
      else {
        found = values["dry-run"]
          ? { ...group, id: virtualId-- }
          : (await tx.insert(menuOptionGroups).values(group).returning())[0];
        count.groups++;
      }
      groupIds.set(group.name, found.id);
      for (const option of options) {
        const input = { ...option, groupId: found.id, isAvailable: true };
        const old = one(
          existingOptions.filter(
            (o) => o.groupId === found.id && key(o.name) === key(option.name),
          ),
          option.name,
        );
        if (old) same(old, input, option.name);
        else {
          if (!values["dry-run"]) await tx.insert(menuOptions).values(input);
          count.options++;
        }
      }
    }
    for (const [position, category] of menuSeed.entries()) {
      let found = one(
        existingCategories.filter((c) => key(c.name) === key(category.name)),
        category.name,
      );
      if (!found) {
        const input = { name: category.name, sortOrder: position };
        found = values["dry-run"]
          ? {
              ...input,
              id: virtualId--,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : (await tx.insert(categories).values(input).returning())[0];
        count.categories++;
      }
      for (const [sortOrder, item] of category.items.entries()) {
        const { groups, ...fields } = item;
        const input = createMenuItemSchema.parse({
          ...fields,
          categoryId: found.id > 0 ? found.id : 1,
          sortOrder,
        });
        input.categoryId = found.id; // virtual IDs are only used by the read-only dry run.
        let old = one(
          existingItems.filter(
            (i) => i.categoryId === found.id && key(i.name) === key(item.name),
          ),
          item.name,
        );
        if (old) same(old, input, item.name);
        else {
          old = values["dry-run"]
            ? {
                ...input,
                id: virtualId--,
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : (await tx.insert(menuItems).values(input).returning())[0];
          count.items++;
        }
        for (const name of groups ?? []) {
          const optionGroupId = groupIds.get(name)!;
          if (
            existingLinks.some(
              (link) =>
                link.menuItemId === old.id &&
                link.optionGroupId === optionGroupId,
            )
          )
            continue;
          if (!values["dry-run"])
            await tx
              .insert(menuItemOptionGroups)
              .values({ menuItemId: old.id, optionGroupId });
          count.links++;
        }
      }
    }
    return count;
  });
  console.log(
    JSON.stringify({
      mode: values["dry-run"] ? "dry-run" : "seeded",
      inserted: counts,
    }),
  );
} catch (err) {
  // Never print database URLs, raw query parameters or environment values.
  console.error(
    err instanceof SeedError
      ? err.message
      : "Menu seed failed; no changes committed. Check migrations and database permissions.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
