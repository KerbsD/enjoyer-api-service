import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

const delays: number[] = [];
mock.module("node:timers/promises", { namedExports: { setTimeout: async (ms: number) => { delays.push(ms); } } });
mock.module("../src/lib/rateLimitStore.ts", { namedExports: { redis: null, createStore: () => undefined, withRedisBreaker: async (fn: () => unknown) => fn() } });
mock.module("../src/configs/cookieOptions.ts", { namedExports: { getRefreshToken: () => undefined } });
const { loginUserBackoff } = await import("../src/lib/authLimiter.ts");
async function login(email: string, status: number) {
  const response = Object.assign(new EventEmitter(), { statusCode: status });
  let continued = false;
  await loginUserBackoff({ ip: "192.0.2.1", body: { email } } as Request, response as unknown as Response, () => { continued = true; });
  assert.equal(continued, true);
  response.emit("finish");
}

test("login middleware delays repeated failures, caps delay and clears after success", async () => {
  delays.length = 0;
  for (let i = 0; i < 5; i++) await login("Backoff@example.test", 401);
  assert.deepEqual(delays, []);
  await login(" backoff@EXAMPLE.test ", 401);
  assert.deepEqual(delays, [250]);
  for (let i = 0; i < 10; i++) await login("backoff@example.test", 401);
  assert.ok(delays.every(ms => ms <= 5000));
  assert.equal(delays.at(-1), 5000);
  await login("backoff@example.test", 200);
  delays.length = 0;
  await login("backoff@example.test", 401);
  assert.deepEqual(delays, []);
});

test("validation and server errors do not add credential failures", async () => {
  delays.length = 0;
  for (let i = 0; i < 10; i++) {
    await login("errors@example.test", 400);
    await login("errors@example.test", 500);
  }
  await login("errors@example.test", 401);
  assert.deepEqual(delays, []);
});
