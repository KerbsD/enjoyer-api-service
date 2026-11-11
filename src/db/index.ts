import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../configs/env.ts";
import { logger, serializeError } from "../lib/logger.ts";
import * as schema from "./schema.ts";

const sslMode =
  env.DB_SSL ?? (env.NODE_ENV === "production" ? "verify" : "off");

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000, // a runaway query can't hold a connection forever
  ssl: sslMode === "off" ? false : { rejectUnauthorized: sslMode === "verify" },
});

// Without this, an error on an idle client crashes the whole process
pool.on("error", (err) => {
  logger.error({ err: serializeError(err) }, "postgres pool error");
});

export const db = drizzle(pool, { schema });
