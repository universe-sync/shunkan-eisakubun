import assert from "node:assert/strict";
import { test } from "node:test";
import { decideLogin, LOGIN_RULE } from "../src/server/gate/limit";
import { loginAttempt } from "../src/server/store/login-failures";
import { forbidNetwork } from "./helpers/no-network";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test("decideLogin：4 回の失敗は wrong、5 回で limited（正しくても）", () => {
  const four = [NOW - 4000, NOW - 3000, NOW - 2000, NOW - 1000];
  assert.deepEqual(decideLogin({ ok: false, mine: four, all: four, now: NOW }), { result: "wrong" });
  assert.deepEqual(decideLogin({ ok: true, mine: four, all: four, now: NOW }), { result: "ok" });
  const five = [...four, NOW - 500];
  assert.equal(decideLogin({ ok: false, mine: five, all: five, now: NOW }).result, "limited");
  assert.equal(decideLogin({ ok: true, mine: five, all: five, now: NOW }).result, "limited");
});

test("decideLogin：ちょうど 10 分前の失敗は数えない", () => {
  const five = [NOW - 10 * MIN, NOW - 3000, NOW - 2000, NOW - 1000, NOW - 500];
  assert.deepEqual(decideLogin({ ok: false, mine: five, all: five, now: NOW }), { result: "wrong" });
  const nineFiftyNine = [NOW - 10 * MIN + 1, NOW - 3000, NOW - 2000, NOW - 1000, NOW - 500];
  assert.equal(decideLogin({ ok: false, mine: nineFiftyNine, all: nineFiftyNine, now: NOW }).result, "limited");
});

test("decideLogin：ほかの key で合わせて 30 回なら、新しい key も limited", () => {
  const all = Array.from({ length: 30 }, (_, i) => NOW - 1000 - i);
  const d = decideLogin({ ok: true, mine: [], all, now: NOW });
  assert.equal(d.result, "limited");
  const all29 = all.slice(0, 29);
  assert.equal(decideLogin({ ok: true, mine: [], all: all29, now: NOW }).result, "ok");
});

test("decideLogin：retryAfterSec は窓の中で最も古い失敗＋10 分から計算され、1 未満にならない", () => {
  const mine = [NOW - 9 * MIN, NOW - 3 * MIN, NOW - 2 * MIN, NOW - 1 * MIN, NOW - 1000];
  const d = decideLogin({ ok: false, mine, all: mine, now: NOW });
  assert.deepEqual(d, { result: "limited", retryAfterSec: 60 });
  // 解除まで 1ms
  const nearly = [NOW - 10 * MIN + 1, NOW - 3000, NOW - 2000, NOW - 1000, NOW - 500];
  assert.deepEqual(decideLogin({ ok: false, mine: nearly, all: nearly, now: NOW }), { result: "limited", retryAfterSec: 1 });
});

test("decideLogin：両方に当たったときは待ち時間の大きい方", () => {
  const mine = [NOW - 9 * MIN, NOW - 3000, NOW - 2000, NOW - 1000, NOW - 500];
  const all = [...Array.from({ length: 29 }, (_, i) => NOW - 2 * MIN - i), NOW - 100];
  const d = decideLogin({ ok: false, mine, all, now: NOW });
  assert.equal(d.result, "limited");
  if (d.result === "limited") {
    // mine は 60 秒、all は最も古い（約 2 分前）＋10 分 → 約 8 分
    assert.ok(d.retryAfterSec > 60 * 7 && d.retryAfterSec <= 60 * 8 + 1, String(d.retryAfterSec));
  }
});

test("loginAttempt：5 回 wrong の後は limited で、表の行は 5 のまま増えない", () => {
  const db = migratedDb(NOW);
  for (let i = 0; i < 5; i++) assert.equal(loginAttempt(db, "a", false, NOW + i * 1000).result, "wrong");
  assert.equal(loginAttempt(db, "a", false, NOW + 6000).result, "limited");
  assert.equal(loginAttempt(db, "a", true, NOW + 7000).result, "limited");
  assert.equal(db.all("SELECT id FROM login_failures").length, 5);
  db.close();
});

test("loginAttempt：正しい合言葉でその key の行が消え、ほかの key の行は残る", () => {
  const db = migratedDb(NOW);
  loginAttempt(db, "a", false, NOW);
  loginAttempt(db, "a", false, NOW + 1);
  loginAttempt(db, "b", false, NOW + 2);
  assert.equal(loginAttempt(db, "a", true, NOW + 3).result, "ok");
  const rows = db.all("SELECT client_key FROM login_failures");
  assert.deepEqual(rows.map((r) => r.client_key), ["b"]);
  db.close();
});

test("loginAttempt：11 分たつとまた試せて、古い行は消える", () => {
  const db = migratedDb(NOW);
  for (let i = 0; i < 5; i++) loginAttempt(db, "a", false, NOW + i);
  assert.equal(loginAttempt(db, "a", true, NOW + 11 * MIN).result, "ok");
  assert.equal(db.all("SELECT id FROM login_failures").length, 0);
  assert.equal(LOGIN_RULE.maxPerKey, 5);
  db.close();
});
