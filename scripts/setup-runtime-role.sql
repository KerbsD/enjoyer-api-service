-- Least-privileged runtime role for the application.
--
-- Run ONCE per database (Neon: per branch) as the owner role (e.g.
-- neondb_owner), from the Neon SQL Editor or psql. Replace the two
-- placeholders first.
--
-- Password: at least ~60 bits of entropy (Neon requirement), e.g.
--   openssl rand -base64 36
--
-- After running this, point the app at the new role in .env:
--   DATABASE_URL           = postgresql://app_runtime:<password>@<pooled-host>/<db>?sslmode=verify-full
--   MIGRATION_DATABASE_URL = postgresql://<owner>:<password>@<direct-host>/<db>?sslmode=verify-full
-- (drizzle-kit needs the owner for DDL; the app never should.)

CREATE ROLE app_runtime WITH LOGIN PASSWORD '<REPLACE_WITH_STRONG_PASSWORD>';

-- Connect + schema usage, nothing more
GRANT CONNECT ON DATABASE <database_name> TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;

-- DML on existing tables and sequences (users, sessions)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Future tables/sequences created by the owner (drizzle-kit migrations)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Keep DDL out even if a grant ever slips in via PUBLIC/defaults
REVOKE CREATE ON SCHEMA public FROM app_runtime;
REVOKE CREATE ON DATABASE <database_name> FROM app_runtime;
