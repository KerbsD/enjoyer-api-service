import nodemailer from "nodemailer";
import { env } from "../configs/env.ts";
import type { Role } from "../db/schema.ts";
import { logger, serializeError } from "../lib/logger.ts";
import { INVITE_TTL_MS, RESET_TTL_MS } from "../lib/tokens.ts";

const transporter = nodemailer.createTransport({
  host: env.EMAIL_HOST,
  port: env.EMAIL_PORT,
  secure: env.EMAIL_SECURE,
  auth: {
    user: env.EMAIL_USER,
    pass: env.EMAIL_PASS, // Use an App Password / API key, not your real password
  },
  pool: true,
  maxConnections: 3,
  // Never let a stalled SMTP server hang a request or a background job forever
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

const FROM = env.EMAIL_FROM ?? `"${env.APP_NAME}" <${env.EMAIL_USER}>`;
const BASE_URL = env.CLIENT_URL.replace(/\/+$/, "");

type MailOptions = Parameters<typeof transporter.sendMail>[0];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Simple in-process retry with backoff (1s, 2s). For guaranteed delivery across
// restarts you'd move this behind a real queue (BullMQ, pg-boss, SQS).
const sendWithRetry = async (
  options: MailOptions,
  attempts = 3,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await transporter.sendMail(options);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
};

/**
 * Fire-and-forget. Sending in the background keeps response time identical
 * whether or not an account exists (no timing oracle) and a failed send can't
 * turn a successful request into a 500.
 */
export const queueEmail = (label: string, send: () => Promise<void>): void => {
  void send().catch((err) =>
    logger.error(
      { email: label, err: serializeError(err) },
      "email delivery failed",
    ),
  );
};

// Tokens go in the URL fragment (#), which browsers never send to servers or
// in Referer headers. The frontend reads location.hash and sends the token to
// PATCH /auth/invite/accept or PATCH /auth/password/reset, respectively.
const inviteUrl = (token: string) => `${BASE_URL}/accept-invite#token=${token}`;
const resetUrl = (token: string) => `${BASE_URL}/reset-password#token=${token}`;

const button = (href: string, label: string, color: string) =>
  `<a href="${href}" style="display:inline-block;padding:12px 24px;background:${color};color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a>`;

// Names are typed by an Owner, so they must be escaped before going into HTML
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

// Link lifetimes are read from the same constants that set the token expiry,
// so the email copy can never drift from what the server enforces.
const inviteHours = Math.round(INVITE_TTL_MS / (60 * 60 * 1000));
const resetMinutes = Math.round(RESET_TTL_MS / (60 * 1000));

const ROLE_PHRASE: Record<Role, string> = {
  owner: "an Owner",
  manager: "a Manager",
  staff: "a member of staff",
};

export type InviteDetails = { name: string; email: string; role: Role };

// Sent when an Owner creates an account (and again on "resend invite"). Awaited
// by the caller on purpose: the Owner needs to know whether it was delivered.
export const sendInviteEmail = async (
  invitee: InviteDetails,
  token: string,
): Promise<void> => {
  const url = inviteUrl(token);
  const role = ROLE_PHRASE[invitee.role];

  await sendWithRetry({
    from: FROM,
    to: invitee.email,
    subject: `You're invited to ${env.APP_NAME}`,
    text: `Hi ${invitee.name},\n\nYou've been added to ${env.APP_NAME} as ${role}. Set your password to get started (link expires in ${inviteHours} hours): ${url}\n\nIf you weren't expecting this, you can ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>You're invited to ${env.APP_NAME}</h2>
        <p>Hi ${escapeHtml(invitee.name)},</p>
        <p>You've been added to ${env.APP_NAME} as ${role}. Set your password to get started. This link expires in <strong>${inviteHours} hours</strong>.</p>
        ${button(url, "Set your password", "#4F46E5")}
        <p style="margin-top:16px;color:#555;">Or copy this link:<br/>${url}</p>
        <p style="margin-top:24px;color:#999;font-size:13px;">If you weren't expecting this, you can ignore this email.</p>
      </div>
    `,
  });
};

export const sendPasswordResetEmail = async (
  email: string,
  token: string,
): Promise<void> => {
  const url = resetUrl(token);

  await sendWithRetry({
    from: FROM,
    to: email,
    subject: "Reset your password",
    text: `Reset your ${env.APP_NAME} password (link expires in ${resetMinutes} minutes): ${url}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Password Reset Request</h2>
        <p>We received a request to reset your password. This link expires in <strong>${resetMinutes} minutes</strong>.</p>
        ${button(url, "Reset Password", "#DC2626")}
        <p style="margin-top:16px;color:#555;">Or paste this link in your browser:<br/>${url}</p>
        <p style="margin-top:24px;color:#999;font-size:13px;">
          If you didn't request this, you can safely ignore this email. Your password will not be changed.
        </p>
      </div>
    `,
  });
};

export const sendPasswordChangedEmail = async (
  email: string,
): Promise<void> => {
  await sendWithRetry({
    from: FROM,
    to: email,
    subject: "Your password was changed",
    text: `The password for your ${env.APP_NAME} account was just changed and all devices were logged out. If this wasn't you, reset your password immediately at ${BASE_URL}.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Your password was changed</h2>
        <p>The password for your ${env.APP_NAME} account was just changed, and all devices were logged out.</p>
        <p><strong>If this wasn't you</strong>, <a href="${BASE_URL}">reset your password immediately</a>.</p>
      </div>
    `,
  });
};
