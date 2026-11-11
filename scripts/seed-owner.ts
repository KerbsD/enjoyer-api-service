// Creates the FIRST Owner account. There is no public sign-up, so this is how
// the very first person gets in; every later account is created by an Owner
// through the account endpoints.
//
//   npm run seed:owner -- --email you@shop.com --name "Your Name"
//
// The password is typed at a hidden prompt (never on the command line, where it
// would land in shell history). When there is no terminal (a deploy or CI job),
// set SEED_OWNER_PASSWORD for that one command instead.
//
// Only DML is needed, so this runs fine with the least-privileged runtime role
// in DATABASE_URL. It refuses to run once any Owner exists.

import { parseArgs } from "node:util";
import bcrypt from "bcrypt";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "../src/db/index.ts";
import { users } from "../src/db/schema.ts";
import { pgCode } from "../src/lib/helpers.ts";
import { securityLog } from "../src/lib/logger.ts";
import { isPwnedPassword } from "../src/lib/pwned.ts";
import { BCRYPT_ROUNDS } from "../src/lib/tokens.ts";
import { emailSchema, resetPasswordSchema } from "../src/validators/auth.ts";

const USAGE = `Usage: npm run seed:owner -- --email <address> --name "<full name>"

The password is read from a hidden prompt. With no terminal, set
SEED_OWNER_PASSWORD for this one command.`;

// Problems the person running the script can fix: printed plainly, no stack
class UserError extends Error {}

// ---------- Hidden password prompt ----------

const readHidden = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const finish = (rest: string) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      // Pasted input may carry the next line too: hand it to the next prompt
      if (rest) stdin.unshift(rest);
      stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]!;
        if (ch === "\r" || ch === "\n" || ch === "\u0004")
          return finish(chunk.slice(i + 1));
        if (ch === "\u0003") {
          // Ctrl+C: leave the terminal usable, then stop
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b")
          value = Array.from(value).slice(0, -1).join("");
        else value += ch;
      }
    };

    stdin.on("data", onData);
  });

const readPassword = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    const first = await readHidden("Password: ");
    const second = await readHidden("Confirm password: ");
    if (first !== second) throw new UserError("The passwords do not match.");
    return first;
  }

  const fromEnv = process.env.SEED_OWNER_PASSWORD;
  delete process.env.SEED_OWNER_PASSWORD;
  if (!fromEnv)
    throw new UserError(
      "No terminal to prompt on. Set SEED_OWNER_PASSWORD for this one command.",
    );
  return fromEnv;
};

// ---------- Main ----------

const ownerCount = async (): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "owner"));
  return row?.n ?? 0;
};

const alreadySeeded = () =>
  new UserError(
    "An Owner account already exists. Further accounts are created by an Owner through the app (forgot a password? use the reset link).",
  );

const main = async (): Promise<void> => {
  let values: { email?: string; name?: string };
  try {
    values = parseArgs({
      options: {
        email: { type: "string" },
        name: { type: "string" },
      },
      strict: true,
    }).values;
  } catch {
    throw new UserError(USAGE);
  }
  if (!values.email || !values.name) throw new UserError(USAGE);

  const email = emailSchema.shape.email.safeParse(values.email);
  if (!email.success)
    throw new UserError(email.error.issues[0]?.message ?? "Invalid email.");

  const name = values.name.trim();
  if (name.length < 1 || name.length > 100)
    throw new UserError("Name must be between 1 and 100 characters.");

  // Cheap check first, so nobody types a password only to be refused
  if ((await ownerCount()) > 0) throw alreadySeeded();

  const password = await readPassword();

  // The same rules as every other password in the app
  const pwd = resetPasswordSchema.shape.newPwd.safeParse(password);
  if (!pwd.success)
    throw new UserError(pwd.error.issues[0]?.message ?? "Invalid password.");
  if (await isPwnedPassword(password))
    throw new UserError(
      "This password has appeared in a known data breach. Choose a different one.",
    );

  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let id: number;
  try {
    const created = await db.transaction(async (tx) => {
      // Two copies of this script at once must not each create an Owner
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('enjoyer:seed-owner'))`,
      );
      const [existing] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.role, "owner"));
      if ((existing?.n ?? 0) > 0) return null;

      const [row] = await tx
        .insert(users)
        .values({
          name,
          email: email.data,
          password: hashed,
          role: "owner",
          active: true,
        })
        .returning({ id: users.id });
      return row ?? null;
    });

    if (!created) throw alreadySeeded();
    id = created.id;
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (pgCode(err) === "23505")
      throw new UserError("That email address is already used by an account.");
    throw err;
  }

  securityLog("owner_seeded", { userId: id });
  console.log(
    `Owner account created for ${email.data} (id ${id}). You can log in now.`,
  );
};

try {
  await main();
} catch (err) {
  if (err instanceof UserError) {
    console.error(err.message);
  } else {
    // Unexpected: say so without echoing query parameters (they hold the hash)
    console.error(
      "Could not create the Owner account:",
      err instanceof Error
        ? (err.message.split("\n")[0] ?? "unknown error")
        : "unknown error",
    );
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
