import type { CookieOptions, Request, Response } from "express";
import { env } from "./env.ts";

// The refresh cookie holds an opaque session token (not a JWT), so it is named
// "refresh" rather than "jwt".
export const REFRESH_COOKIE_NAME = "refresh";

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: env.COOKIE_SAMESITE,
  // Browsers reject SameSite=None without Secure
  secure: env.NODE_ENV === "production" || env.COOKIE_SAMESITE === "none",
  // The refresh cookie is only sent to /auth/* (both /auth/refresh and
  // /auth/logout need it), not to every endpoint. If you don't want to mount
  // routes under /auth, change this to "/".
  path: "/auth",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

// clearCookie must use the same attributes (path, sameSite, secure) but not maxAge
const { maxAge: _maxAge, ...CLEAR_COOKIE_OPTIONS } = COOKIE_OPTIONS;

/** Reads the refresh token from the cookie. */
export const getRefreshToken = (req: Request): string | undefined => {
  const value = req.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Clears the refresh cookie (used on logout and on rejected refreshes). */
export const clearRefreshCookies = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_COOKIE_OPTIONS);
};

export default COOKIE_OPTIONS;
