import assert from "node:assert/strict";
import { test } from "node:test";
import { loginMessage, loginOutcome } from "../src/client/lib/login-result";
import { LOGIN } from "../src/client/strings";
import { forbidNetwork } from "./helpers/no-network";

forbidNetwork();

test("loginOutcome の対応", () => {
  assert.deepEqual(loginOutcome(200, { ok: true }), { kind: "ok" });
  assert.deepEqual(loginOutcome(401, { reason: "wrong" }), { kind: "wrong" });
  assert.deepEqual(loginOutcome(429, { reason: "limited", retryAfterSec: 61 }), { kind: "limited", minutes: 2 });
  assert.deepEqual(loginOutcome(429, { retryAfterSec: 1 }), { kind: "limited", minutes: 1 });
  assert.deepEqual(loginOutcome(429, { retryAfterSec: 600 }), { kind: "limited", minutes: 10 });
  assert.deepEqual(loginOutcome(429, null), { kind: "limited", minutes: 10 });
  assert.deepEqual(loginOutcome(429, { retryAfterSec: "x" }), { kind: "limited", minutes: 10 });
  assert.deepEqual(loginOutcome(503, { error: "合言葉が未設定です。", reason: "not_configured" }), { kind: "not_configured", message: "合言葉が未設定です。" });
  assert.deepEqual(loginOutcome(503, null), { kind: "not_configured", message: LOGIN.error });
  assert.deepEqual(loginOutcome(0, null), { kind: "network" });
  assert.deepEqual(loginOutcome(500, null), { kind: "error" });
  assert.deepEqual(loginOutcome(403, null), { kind: "error" });
  assert.deepEqual(loginOutcome(400, { reason: "bad_request" }), { kind: "error" });
});

test("loginMessage の文言", () => {
  assert.equal(loginMessage({ kind: "ok" }), "");
  assert.equal(loginMessage({ kind: "wrong" }), "合言葉が違います。");
  assert.equal(loginMessage({ kind: "limited", minutes: 3 }), "間違いが続いたため、約3分は入れません。");
  assert.equal(loginMessage({ kind: "not_configured", message: "サーバーの文" }), "サーバーの文");
  assert.equal(loginMessage({ kind: "network" }), "通信できませんでした。");
  assert.equal(loginMessage({ kind: "error" }), "ログインできませんでした。");
});
