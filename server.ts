import app from "./src/app.ts";
import { env } from "./src/configs/env.ts";
import { pool } from "./src/db/index.ts";
import { logger, serializeError } from "./src/lib/logger.ts";
import { closeRedis } from "./src/lib/rateLimitStore.ts";
import { runMaintenance } from "./src/lib/maintenance.ts";
import { closeRealtimeStreams } from "./src/lib/realtime/stream.ts";
// ---------- Startup ----------

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;

void runMaintenance();
const maintenanceTimer = setInterval(
  () => void runMaintenance(),
  60 * 1000,
);
maintenanceTimer.unref();

// ---------- Graceful shutdown ----------

let shuttingDown = false;

const shutdown = (reason: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, "shutting down");

  setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000).unref();

  clearInterval(maintenanceTimer);
  closeRealtimeStreams();

  server.close(async () => {
    try {
      await closeRedis();
      await pool.end();
    } catch (err) {
      logger.error({ err: serializeError(err) }, "error during shutdown");
      exitCode = 1;
    }
    process.exit(exitCode);
  });
  server.closeIdleConnections();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: serializeError(reason) }, "unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err: serializeError(err) }, "uncaught exception");
  shutdown("uncaughtException", 1);
});

