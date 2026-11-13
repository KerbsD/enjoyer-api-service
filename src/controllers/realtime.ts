import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { getTableSessionContext } from "../middlewares/tableSession.ts";
import { currentUser } from "../middlewares/requirePermission.ts";
import { staffAccess, tableAccess } from "../lib/realtime/access.ts";
import type { RealtimeAccess } from "../lib/realtime/access.ts";
import { readRevisions } from "../lib/realtime/revisions.ts";
import {
  openRealtimeStream,
  POLL_INTERVAL_MS,
} from "../lib/realtime/stream.ts";
import { validateQuery } from "../lib/validate.ts";

const fields = {
  since: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
export const validateStaffRealtime = validateQuery(z.strictObject(fields));
export const validateTableRealtime = validateQuery(
  z.strictObject({
    ...fields,
    sessionId: z.uuid(),
  }),
);

export const prepareTableRealtime: RequestHandler = async (req, res, next) => {
  const context = getTableSessionContext(res);
  if (res.locals.query.sessionId !== context.session.id)
    return res
      .status(409)
      .json({
        success: false,
        code: "TABLE_SESSION_REQUIRED",
        message: "This table session has ended. Scan the QR code again.",
      });
  const access = tableAccess(
    context.table.id,
    context.session.id,
    req.get("x-table-token")!,
  );
  const failure = await access.check();
  if (failure)
    return res.status(failure.status).json({ success: false, ...failure });
  res.locals.realtime = access;
  next();
};

export const prepareStaffRealtime: RequestHandler = (req, res, next) => {
  res.locals.realtime = staffAccess(
    currentUser(req).id,
    req.headers.authorization!.slice(7).trim(),
  );
  next();
};

export const streamChanges = (_req: Request, res: Response) =>
  openRealtimeStream(res, res.locals.realtime as RealtimeAccess);

export const pollChanges = async (_req: Request, res: Response) => {
  const access = res.locals.realtime as RealtimeAccess;
  const state = await readRevisions(access.scope);
  // Also recheck after the read: expiry/closure can race the HTTP middleware.
  const failure = await access.check();
  if (failure)
    return res.status(failure.status).json({ success: false, ...failure });
  if (res.locals.query.since === state.revision) return res.status(204).end();
  return res.json({
    success: true,
    data: {
      ...state,
      scope: access.scope,
      pollIntervalMs: POLL_INTERVAL_MS,
    },
  });
};
