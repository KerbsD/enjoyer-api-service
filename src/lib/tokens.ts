import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../configs/env.ts";
import type { Role } from "../db/schema.ts";
import { isRole } from "./permissions.ts";

// ---------- Opaque tokens ----------

// 32 random bytes = 256 bits of entropy, 43 URL-safe characters.
export const newToken = (): string => randomBytes(32).toString("base64url");

// Tokens are high-entropy, so a fast hash is correct here (bcrypt isn't needed).
export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// Cheap shape check so junk input never reaches the database
export const isWellFormedToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN_SHAPE.test(value);

export const BCRYPT_ROUNDS = 12;

// ---------- Lifetimes (tune these) ----------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const REFRESH_TTL_MS = 1 * DAY; // each refresh token (sliding)
export const ABSOLUTE_SESSION_TTL_MS = 7 * DAY; // hard cap per login
export const REFRESH_GRACE_MS = 10 * 1000; // multi-tab race window
export const INVITE_TTL_MS = 72 * HOUR; // matches the verification email copy
export const RESET_TTL_MS = 15 * MINUTE; // matches the reset email copy
export const EMAIL_COOLDOWN_MS = 2 * MINUTE;

// ---------- Access token (short-lived JWT) ----------

const JWT_ALGORITHM = "HS256" as const;
const JWT_ISSUER = "auth-api";
const JWT_AUDIENCE = "auth-api-clients";
const ACCESS_TOKEN_TYPE = "access";

// The token proves identity. verifyJwt checks the account's current active
// state and role in the database before authorizing each protected request.
export type AccessTokenUser = { id: number; role: Role };

export const signAccessToken = (userId: number, role: Role): string =>
  jwt.sign({ typ: ACCESS_TOKEN_TYPE, role }, env.ACCESS_TOKEN_SECRET, {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: String(userId), // immutable identity; emails can change
    expiresIn: env.NODE_ENV === "production" ? "1m" : "10m",
  });

/** Throws (JsonWebTokenError / TokenExpiredError) if the token is not a valid access token. */
export const verifyAccessToken = (token: string): AccessTokenUser => {
  const payload = jwt.verify(token, env.ACCESS_TOKEN_SECRET, {
    algorithms: [JWT_ALGORITHM], // never trust the header's alg
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });

  if (
    typeof payload === "string" ||
    payload.typ !== ACCESS_TOKEN_TYPE ||
    typeof payload.sub !== "string" ||
    !/^\d+$/.test(payload.sub) ||
    // A signed token with an unknown or missing role is rejected, never
    // defaulted: failing closed is the only safe answer for authorization.
    !isRole(payload.role)
  ) {
    throw new jwt.JsonWebTokenError("Invalid token payload");
  }

  return { id: Number(payload.sub), role: payload.role };
};
