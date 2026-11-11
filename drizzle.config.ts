import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations need DDL rights, so they run as the database owner over a direct
// connection. The app itself connects with the least-privileged runtime role
// from DATABASE_URL (see scripts/setup-runtime-role.sql).
const migrationUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL (or DATABASE_URL) is not set in the .env file",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts", // Your schema file path
  out: "./drizzle", // Your migrations folder
  dbCredentials: {
    url: migrationUrl,
  },
});
