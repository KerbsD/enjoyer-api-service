import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginFailureStore } from "../src/lib/loginFailureStore.ts";

test("expired failure records are swept without revisiting their email", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const store = new LoginFailureStore(15 * 60_000);
  try {
    for (let i = 0; i < 1000; i++) store.bump(`person-${i}@example.test`);
    assert.equal(store.size, 1000);
    t.mock.timers.tick(16 * 60_000);
    assert.equal(store.size, 0);
  } finally {
    store.close();
  }
});

test("capacity stays bounded and repeated failures preserve active counters", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const store = new LoginFailureStore(60_000, 3);
  try {
    for (const key of ["a", "b", "c", "a", "d"]) store.bump(key);
    assert.equal(store.size, 3);
    assert.equal(store.get("a"), 2);
    assert.equal(store.get("b"), 0);
    for (let i = 0; i < 1000; i++) store.bump(`new-${i}`);
    assert.equal(store.size, 3);
  } finally {
    store.close();
  }
});

test("expiry slides on failure, success clears it, and expired counters restart", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const store = new LoginFailureStore(1000, 10, 5000);
  try {
    store.bump("a");
    t.mock.timers.tick(750);
    store.bump("a");
    t.mock.timers.tick(750);
    assert.equal(store.get("a"), 2);
    store.clear("a");
    assert.equal(store.get("a"), 0);
    store.bump("a");
    t.mock.timers.tick(1000);
    store.bump("a");
    assert.equal(store.get("a"), 1);
  } finally {
    store.close();
  }
});
