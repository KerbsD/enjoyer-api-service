import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { settings } from "../../db/schema.ts";
import { readShopSettings } from "../../lib/settings.ts";
import type { UpdateSettingsInput } from "../../validators/settings.ts";

const send = async (res: Response, status = 200) =>
  res.status(status).json({ success: true, data: await readShopSettings() });

export const getSettings = async (_req: Request, res: Response) =>
  send(res);

export const updateSettings = async (req: Request, res: Response) => {
  const input = req.body as UpdateSettingsInput;
  const changes: { key: string; value: string }[] = [];
  if (input.idleTimeoutMinutes !== undefined)
    changes.push({
      key: "idle_timeout_minutes",
      value: String(input.idleTimeoutMinutes),
    });
  if (input.confirmationExpiryMinutes !== undefined)
    changes.push({
      key: "confirmation_expiry_minutes",
      value: String(input.confirmationExpiryMinutes),
    });

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const change of changes)
      await tx
        .insert(settings)
        .values(change)
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: change.value, updatedAt: now },
        });
  });

  return send(res);
};
