// IP ごとの頻度制限（1 分の区切り）。音声を送る回答＝40回/分、読み上げ＝30回/分。回答なし・start などは数えない
import assert from "node:assert/strict";
import { test } from "node:test";
import { hitRate } from "../src/server/guard/rate-limit";
import { forbidNetwork } from "./helpers/no-network";
import { makeApi, T0 } from "./helpers/api";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();

// 本文が正しくない answer（400）も、本文を読む前に数える。外部 API を呼ばずに回数だけを試せる
const ip = (address: string) => ({ "CF-Connecting-IP": address });

test("41回目の answer は429で Retry-After が付き、次の分で通る", async () => {
  const a = makeApi({ now: Date.UTC(2026, 9, 21, 3, 0, 20) });
  for (let i = 0; i < 40; i += 1) assert.equal((await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"))).status, 400, `${i + 1}回目`);
  const limited = await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "rate_limited");
  assert.equal(limited.body.retryAfterSec, 40);
  assert.equal(limited.headers.get("Retry-After"), "40");
  assert.match(limited.body.error, /40秒ほど待ってから/);
  // 断った分は数えない
  assert.equal(a.db.all("SELECT count FROM rate_hits WHERE bucket = 'answer'")[0]?.count, 40);
  a.clock.now = Date.UTC(2026, 9, 21, 3, 1, 0);
  assert.equal((await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"))).status, 400);
});

test("IP ごとに別々に数える。CF-Connecting-IP が無い要求は local にまとまる", async () => {
  const a = makeApi();
  for (let i = 0; i < 40; i += 1) await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"));
  assert.equal((await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"))).status, 429);
  assert.equal((await a.postJson("/api/instant/answer", {}, ip("203.0.113.2"))).status, 400);
  assert.equal((await a.postJson("/api/instant/answer", {})).status, 400);
  assert.equal(a.db.all("SELECT client_key FROM rate_hits WHERE bucket = 'answer' ORDER BY client_key").map((r) => r.client_key).join(","), "203.0.113.1,203.0.113.2,local");
});

test("speech は31回目で429。answer の回数とは別の数", async () => {
  const a = makeApi();
  for (let i = 0; i < 30; i += 1) assert.equal((await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" }, ip("203.0.113.1"))).status, 200, `${i + 1}回目`);
  const limited = await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" }, ip("203.0.113.1"));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "rate_limited");
  assert.equal((await a.postJson("/api/instant/answer", {}, ip("203.0.113.1"))).status, 400); // answer はまだ数が残っている
});

test("no-answer・start・finish・settings・reset は数えない", async () => {
  const a = makeApi();
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await a.postJson("/api/instant/no-answer", {}, ip("203.0.113.1"))).status, 400);
    assert.notEqual((await a.postJson("/api/instant/finish", {}, ip("203.0.113.1"))).status, 429);
  }
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM rate_hits")[0]?.n, 0);
});

test("RATE_ANSWER_PER_MINUTE で変えられる", async () => {
  const a = makeApi({ env: { RATE_ANSWER_PER_MINUTE: "2" } });
  assert.equal((await a.postJson("/api/instant/answer", {})).status, 400);
  assert.equal((await a.postJson("/api/instant/answer", {})).status, 400);
  assert.equal((await a.postJson("/api/instant/answer", {})).status, 429);
});

test("hitRate：2分より前の行は消える。retryAfterSec は区切りの終わりまで（最小1）", () => {
  const db = migratedDb(T0);
  const w = Math.floor(T0 / 60_000) * 60_000;
  db.run("INSERT INTO rate_hits (bucket, client_key, window_start_ms, count) VALUES ('answer', 'old', ?, 5), ('answer', 'prev', ?, 5)", w - 180_000, w - 60_000);
  assert.deepEqual(hitRate(db, "answer", "k", 1, w + 59_999), { ok: true });
  assert.deepEqual(hitRate(db, "answer", "k", 1, w + 59_999), { ok: false, retryAfterSec: 1 });
  assert.deepEqual(db.all("SELECT client_key FROM rate_hits ORDER BY client_key").map((r) => r.client_key), ["k", "prev"]);
  db.close();
});
