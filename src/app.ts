import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import { env } from "./configs/env.ts";
import corsOptions from "./configs/corsOption.ts";
import { pool } from "./db/index.ts";

import { globalLimiter } from "./lib/authLimiter.ts";

import { requestLogger } from "./middlewares/requestLogger.ts";
import errorHandler from "./middlewares/errorHandler.ts";
import notFound from "./middlewares/notFound.ts";
import { noStore } from "./middlewares/noStore.ts";
import { verifyJwt } from "./middlewares/verifyJwt.ts";

import loginRoute from "./routes/auth/login.ts";
import passwordRoute from "./routes/auth/password.ts";
import refreshTokenRoute from "./routes/auth/refresh.ts";
import logoutRoute from "./routes/auth/logout.ts";
import inviteRoute from "./routes/auth/invite.ts";
import { handleCurrentUser } from "./controllers/accounts/getAccount.ts";

import adminAccountsRoute from "./routes/accounts/admin.ts";
import adminCategoriesRoute from "./routes/categories/admin.ts";
import optionGroupsRoute from "./routes/menuItems/optionGroups.ts";
import adminMenuItemsRoute from "./routes/menuItems/admin.ts";
import staffMenuItemsRoute from "./routes/menuItems/staff.ts";
import { handlePublicMenu } from "./controllers/menuItems/public.ts";
import adminTablesRoute from "./routes/tables/admin.ts";
import staffTablesRoute from "./routes/tables/staff.ts";
import publicTablesRoute from "./routes/tables/public.ts";
import publicCartRoute from "./routes/cart/public.ts";
import adminSettingsRoute from "./routes/settings/admin.ts";
import adminStoreHoursRoute from "./routes/storeHours/admin.ts";
import adminHolidayOverridesRoute from "./routes/storeHours/holidays.ts";
import { getPublicStoreStatus } from "./controllers/storeHours/public.ts";
import publicOrdersRoute from "./routes/orders/public.ts";
import staffOrdersRoute from "./routes/orders/staff.ts";
import staffOrderTablesRoute from "./routes/orders/tables.ts";
import { staffRealtime, tableRealtime } from "./routes/realtime.ts";
import { dashboardRoute, exportRoute, historyRoute } from "./routes/reports/admin.ts";

const app = express();
if (env.TRUST_PROXY_HOPS > 0) app.set("trust proxy", env.TRUST_PROXY_HOPS);
app.disable("x-powered-by");

app.use(requestLogger);
app.use(helmet());
app.use(noStore);
app.use(cors(corsOptions));
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

let dbReadiness = { ok: true, checkedAt: 0 };
const READINESS_CACHE_MS = 5_000;

app.get("/health/ready", async (_req, res) => {
  if (Date.now() - dbReadiness.checkedAt > READINESS_CACHE_MS) {
    try {
      await pool.query("select 1");
      dbReadiness = { ok: true, checkedAt: Date.now() };
    } catch {
      dbReadiness = { ok: false, checkedAt: Date.now() };
    }
  }
  res.status(dbReadiness.ok ? 200 : 503).json({ ok: dbReadiness.ok });
});

// Realtime routes have their own NAT-friendly IP and authenticated quotas.
// Both routers authenticate independently before sending any data.
app.use("/tables/realtime", tableRealtime);
app.use("/staff/realtime", staffRealtime);
app.use(globalLimiter);

// Staff authentication. There is no public sign-up: accounts are created by
// the Owner, and /auth/password/reset also completes an invite.
app.use("/auth/login", loginRoute);
app.use("/auth/password", passwordRoute);
app.use("/auth/refresh", refreshTokenRoute);
app.use("/auth/logout", logoutRoute);
app.use("/auth/invite", inviteRoute);

// Public routes for customers (QR menu, ordering) are mounted here, above
// verifyJwt. Customers never log in.
app.get("/menu", handlePublicMenu);
app.get("/store/status", getPublicStoreStatus);
app.use("/tables/cart", publicCartRoute);
app.use("/tables/orders", publicOrdersRoute);
app.use("/tables", publicTablesRoute);

app.use(verifyJwt);

app.get("/auth/me", handleCurrentUser);
app.use("/admin/accounts", adminAccountsRoute);
app.use("/admin/categories", adminCategoriesRoute);
app.use("/admin/option-groups", optionGroupsRoute);
app.use("/admin/menu-items", adminMenuItemsRoute);
app.use("/staff/menu-items", staffMenuItemsRoute);
app.use("/admin/tables", adminTablesRoute);
app.use("/staff/tables", staffTablesRoute);
app.use("/staff/orders", staffOrdersRoute);
app.use("/staff/tables", staffOrderTablesRoute);
app.use("/admin/settings", adminSettingsRoute);
app.use("/admin/store-hours", adminStoreHoursRoute);
app.use("/admin/holiday-overrides", adminHolidayOverridesRoute);
app.use("/admin/dashboard", dashboardRoute);
app.use("/admin/orders", historyRoute);
app.use("/admin/exports", exportRoute);

// Everything below needs a valid access token. Guard each route with
// requirePermission("...") from src/middlewares/requirePermission.ts, e.g.
//   router.patch("/:id/status", requirePermission("order:advance"), handler);

app.all("*splat", notFound);
app.use(errorHandler);

export default app;
