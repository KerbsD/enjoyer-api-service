import { createHash } from "node:crypto";
import { env } from "../configs/env.ts";
import { securityLog, serializeError } from "./logger.ts";
import { countEvent } from "./metrics.ts";

/**
 * HaveIBeenPwned range API (k-anonymity): only the first 5 characters of the
 * SHA-1 hash leave this server, never the password.
 *
 * Fails OPEN on purpose: if the service is down or slow, registration and
 * resets must still work. Each fail-open emits a security log + counter so a
 * prolonged outage is alertable instead of silently weakening the check.
 * (Production cannot disable the check: see PWNED_PASSWORD_CHECK in env.ts.)
 */
export const isPwnedPassword = async (password: string): Promise<boolean> => {
  if (env.PWNED_PASSWORD_CHECK === "off") return false;

  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" }, // padded responses hide the match count
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`HIBP responded with ${res.status}`);

    const body = await res.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch (err) {
    securityLog(
      "pwned_check_unavailable",
      { err: serializeError(err) },
      "warn",
    );
    countEvent("pwned_check_unavailable");
    return false;
  }
};

export const pwnedPasswordResponse = (field: string) => ({
  success: false,
  message: "Validation failed.",
  errors: [
    {
      field,
      message:
        "This password has appeared in a known data breach. Please choose a different one.",
    },
  ],
});
