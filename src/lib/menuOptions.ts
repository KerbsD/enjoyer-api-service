import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { menuItemOptionGroups, menuOptionGroups, menuOptions } from "../db/schema.ts";

export type OptionGroupView = {
  id: number; name: string; required: boolean;
  minSelections: number; maxSelections: number; sortOrder: number;
  options: { id: number; name: string; priceDelta: string; isAvailable: boolean; sortOrder: number }[];
};

// One batched query for all displayed items, avoiding one lookup per menu item.
export const getItemOptionGroups = async (itemIds: number[]): Promise<Map<number, OptionGroupView[]>> => {
  const result = new Map<number, OptionGroupView[]>();
  if (!itemIds.length) return result;
  const rows = await db.select({
    menuItemId: menuItemOptionGroups.menuItemId,
    groupId: menuOptionGroups.id, groupName: menuOptionGroups.name,
    required: menuOptionGroups.required,
    minSelections: menuOptionGroups.minSelections,
    maxSelections: menuOptionGroups.maxSelections,
    groupSortOrder: menuOptionGroups.sortOrder,
    id: menuOptions.id, name: menuOptions.name, priceDelta: menuOptions.priceDelta,
    isAvailable: menuOptions.isAvailable, sortOrder: menuOptions.sortOrder,
  }).from(menuItemOptionGroups)
    .innerJoin(menuOptionGroups, eq(menuItemOptionGroups.optionGroupId, menuOptionGroups.id))
    .innerJoin(menuOptions, eq(menuOptions.groupId, menuOptionGroups.id))
    .where(inArray(menuItemOptionGroups.menuItemId, itemIds))
    .orderBy(asc(menuOptionGroups.sortOrder), asc(menuOptionGroups.id), asc(menuOptions.sortOrder), asc(menuOptions.id));
  for (const { menuItemId, groupId, groupName, required, minSelections, maxSelections, groupSortOrder, ...option } of rows) {
    const groups = result.get(menuItemId) ?? [];
    let group = groups.find(g => g.id === groupId);
    if (!group) {
      group = { id: groupId, name: groupName, required, minSelections, maxSelections, sortOrder: groupSortOrder, options: [] };
      groups.push(group); result.set(menuItemId, groups);
    }
    group.options.push(option);
  }
  return result;
};
