import { and, asc, eq, inArray } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import {
  menuItems,
  menuOptionGroups,
  menuOptions,
  menuItemOptionGroups,
} from "../../db/schema.ts";
import { parseId, pgCode } from "../../lib/helpers.ts";
import { getItemOptionGroups } from "../../lib/menuOptions.ts";
import { CURRENCY } from "../../configs/currency.ts";
import type { z } from "zod";
import type { createOptionGroupSchema } from "../../validators/menuOptions.ts";

const missing = (res: Response) =>
  res.status(404).json({
    success: false,
    message: "Menu item, option group, or option not found.",
  });
const send = (res: Response, data: unknown) =>
  res.json({ success: true, currency: CURRENCY, data });

export const listOptionGroups = async (_req: Request, res: Response) => {
  const [groups, options] = await Promise.all([
    db
      .select()
      .from(menuOptionGroups)
      .orderBy(asc(menuOptionGroups.sortOrder), asc(menuOptionGroups.id)),
    db
      .select()
      .from(menuOptions)
      .orderBy(asc(menuOptions.sortOrder), asc(menuOptions.id)),
  ]);
  return send(
    res,
    groups.map((group) => ({
      ...group,
      maxSelections: 1,
      options: options.filter((o) => o.groupId === group.id),
    })),
  );
};

export const createOptionGroup = async (req: Request, res: Response) => {
  const { options, ...input } = req.body as z.infer<
    typeof createOptionGroupSchema
  >;
  const data = await db.transaction(async (tx) => {
    const [group] = await tx.insert(menuOptionGroups).values(input).returning();
    const created = await tx
      .insert(menuOptions)
      .values(options.map((option) => ({ ...option, groupId: group.id })))
      .returning();
    return { ...group, maxSelections: 1, options: created };
  });
  return send(res.status(201), data);
};

export const updateOptionGroup = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return missing(res);
  const [group] = await db
    .update(menuOptionGroups)
    .set(req.body)
    .where(eq(menuOptionGroups.id, id))
    .returning();
  return group ? send(res, { ...group, maxSelections: 1 }) : missing(res);
};

export const createOption = async (req: Request, res: Response) => {
  const groupId = parseId(req.params.id);
  if (!groupId) return missing(res);
  try {
    const [option] = await db
      .insert(menuOptions)
      .values({ ...req.body, groupId })
      .returning();
    return send(res.status(201), option);
  } catch (err) {
    if (pgCode(err) === "23503") return missing(res);
    throw err;
  }
};

export const updateOption = async (req: Request, res: Response) => {
  const groupId = parseId(req.params.id),
    id = parseId(req.params.optionId);
  if (!groupId || !id) return missing(res);
  const [option] = await db
    .update(menuOptions)
    .set(req.body)
    .where(and(eq(menuOptions.id, id), eq(menuOptions.groupId, groupId)))
    .returning();
  return option ? send(res, option) : missing(res);
};

export const listItemOptionGroups = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return missing(res);
  const [item] = await db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(eq(menuItems.id, id));
  if (!item) return missing(res);
  return send(res, (await getItemOptionGroups([id])).get(id) ?? []);
};

export const assignOptionGroups = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);

  if (!id) return missing(res);

  const { groupIds } = req.body as { groupIds: number[] };
  
  const outcome = await db.transaction(async (tx) => {
    // Serialize replacements on this item; validation precedes link deletion.
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(eq(menuItems.id, id))
      .for("update");
    if (!item) return "missing";
    if (groupIds.length) {
      const found = await tx
        .select({ id: menuOptionGroups.id })
        .from(menuOptionGroups)
        .where(inArray(menuOptionGroups.id, groupIds));
      if (found.length !== groupIds.length) return "invalid";
    }
    await tx
      .delete(menuItemOptionGroups)
      .where(eq(menuItemOptionGroups.menuItemId, id));
    if (groupIds.length)
      await tx
        .insert(menuItemOptionGroups)
        .values(
          groupIds.map((optionGroupId) => ({ menuItemId: id, optionGroupId })),
        );
    return "ok";
  });
  if (outcome === "missing") return missing(res);
  if (outcome === "invalid")
    return res
      .status(400)
      .json({ success: false, message: "An option group does not exist." });
  return send(res, { menuItemId: id, groupIds });
};
