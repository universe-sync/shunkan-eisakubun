// 1日の上限（日本時間で区切る）。回数・利用料（円）・読み上げ。声なしの記録は数えない
import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyLimitMessage, dailyState, reserveDaily } from "../src/server/guard/daily-limits";
import { GUARD_DEFAULTS, guardConfig } from "../src/server/guard/config";
import { forbidNetwork } from "./helpers/no-network";
import { beginSession, makeApi, T0 } from "./helpers/api";
import { migratedDb } from "./helpers/sqlite";
import { silence, speechLike, toBase64, toWav } from "./helpers/wav-fixtures";

forbidNetwork();

const voiced = () => toBase64(toWav(speechLike()));
const quiet = () => toBase64(toWav(silence(2.2)));
const answerBody = (s: { sessionId: string; ids: string[] }, i: number, audioBase64: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId: s.sessionId, questionId: s.ids[i], mimeType: "audio/wav", audioBase64, segmentEnd: "timeout", ...extra });

test("DAILY_ANSWER_LIMIT=2：3回目の声のある答えは429で、Gemini を呼ばず、記録も変えない", async () => {
  const a = makeApi({ env: { DAILY_ANSWER_LIMIT: "2" } });
  const s = await beginSession(a);
  for (let i = 0; i < 2; i += 1) assert.equal((await a.postJson("/api/instant/answer", answerBody(s, i, voiced()))).status, 200);
  assert.equal(a.ai.geminiCalls.length, 2);
  const limited = await a.postJson("/api/instant/answer", answerBody(s, 2, voiced()));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "daily_limit");
  assert.equal(limited.body.limit, "answers");
  assert.equal(limited.body.error, "今日の採点の上限（2回）に達しました。日本時間の0時を過ぎると、また採点できます。");
  assert.ok(limited.body.audio);
  assert.equal(a.ai.geminiCalls.length, 2);
  assert.equal(a.ai.claudeCalls.length, 2);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0]?.n, 2);
  // 次の問題は記録されないままなので、日付が変われば答えられる
  assert.equal((await a.getJson("/api/instant/status")).body.activeSession.pendingQuestionIds.length, 8);
});

test("回答なし（no-answer と声のない WAV）は数えず、上限に達していても記録できる", async () => {
  const a = makeApi({ env: { DAILY_ANSWER_LIMIT: "1" } });
  const s = await beginSession(a);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 0, voiced()))).status, 200);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 1, voiced()))).status, 429);
  const noAnswer = await a.postJson("/api/instant/no-answer", { sessionId: s.sessionId, questionId: s.ids[1], segmentEnd: "timeout" });
  assert.equal(noAnswer.status, 200);
  assert.equal(noAnswer.body.attempt.outcome, "no_answer");
  const silent = await a.postJson("/api/instant/answer", answerBody(s, 2, quiet()));
  assert.equal(silent.status, 200);
  assert.equal(silent.body.attempt.outcome, "no_answer");
  assert.equal(a.db.all("SELECT count FROM daily_counters WHERE name = 'answer'")[0]?.count, 1);
});

test("日本時間の0時（14:59:59Z → 15:00:00Z）で戻る", async () => {
  const a = makeApi({ now: Date.UTC(2026, 9, 21, 14, 59, 59), env: { DAILY_ANSWER_LIMIT: "1" } });
  const s = await beginSession(a);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 0, voiced()))).status, 200);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 1, voiced()))).status, 429);
  assert.equal((await a.getJson("/api/instant/status")).body.daily.date, "2026-10-21");
  a.clock.now = Date.UTC(2026, 9, 21, 15, 0, 0);
  const status = (await a.getJson("/api/instant/status")).body;
  assert.equal(status.daily.date, "2026-10-22");
  assert.equal(status.daily.answers.used, 0);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 1, voiced()))).status, 200);
});

function seedYen(a: ReturnType<typeof makeApi>, usd: number): void {
  const day = new Date(a.clock.now + 9 * 3600_000).toISOString().slice(0, 10);
  a.db.run("INSERT INTO usage_days (day, model, calls, usd) VALUES (?, 'gemini-3.8-flash', 1, ?)", day, usd);
}

test("円の上限（DAILY_YEN_LIMIT=1）：answer・speech・start が429になる。回答なしは記録できる", async () => {
  const a = makeApi({ env: { DAILY_YEN_LIMIT: "1" } });
  const s = await beginSession(a);
  seedYen(a, 0.01); // 1.56円
  const limited = await a.postJson("/api/instant/answer", answerBody(s, 0, voiced()));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.limit, "yen");
  assert.equal(limited.body.error, "今日の利用料の上限（約1円）に達しました。日本時間の0時を過ぎると、また使えます。");
  const speech = await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" });
  assert.equal(speech.status, 429);
  assert.equal(speech.body.limit, "yen");
  await a.postJson("/api/instant/finish", { sessionId: s.sessionId, reason: "stopped" });
  const start = await a.postJson("/api/instant/start", { generationId: (await a.getJson("/api/instant/status")).body.generationId });
  assert.equal(start.status, 429);
  assert.equal(start.body.reason, "daily_limit");
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_sessions")[0]?.n, 1); // 出題を作らない
  assert.equal(a.ai.geminiCalls.length, 0);
  const s2 = await (async () => { const r = makeApi({ env: { DAILY_YEN_LIMIT: "1" } }); const s = await beginSession(r); seedYen(r, 0.01); return { r, s }; })();
  const noAnswer = await s2.r.postJson("/api/instant/no-answer", { sessionId: s2.s.sessionId, questionId: s2.s.ids[0], segmentEnd: "next" });
  assert.equal(noAnswer.status, 200);
});

test("start：回答の回数の上限に達していれば429（出題を作らない）", async () => {
  const a = makeApi({ env: { DAILY_ANSWER_LIMIT: "1" } });
  const s = await beginSession(a);
  assert.equal((await a.postJson("/api/instant/answer", answerBody(s, 0, voiced()))).status, 200);
  await a.postJson("/api/instant/finish", { sessionId: s.sessionId, reason: "stopped" });
  const start = await a.postJson("/api/instant/start", { generationId: (await a.getJson("/api/instant/status")).body.generationId });
  assert.equal(start.status, 429);
  assert.equal(start.body.limit, "answers");
});

test("読み上げの回数の上限（DAILY_SPEECH_LIMIT=2）：3回目は429で Gemini を呼ばない", async () => {
  const a = makeApi({ env: { DAILY_SPEECH_LIMIT: "2" } });
  for (let i = 0; i < 2; i += 1) assert.equal((await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" })).status, 200);
  const calls = a.ai.geminiCalls.length;
  const limited = await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "daily_limit");
  assert.equal(limited.body.limit, "speech");
  assert.equal(limited.body.error, "今日の読み上げの上限（2回）に達しました。日本時間の0時を過ぎると、また使えます。");
  assert.equal(a.ai.geminiCalls.length, calls);
  // 見つからない読み上げ対象は数えない
  assert.equal((await a.postJson("/api/instant/speech", { questionId: "q001" })).status, 404);
});

test("status と usage に daily が付く", async () => {
  const a = makeApi();
  const status = (await a.getJson("/api/instant/status")).body;
  assert.deepEqual(status.daily, {
    date: "2026-10-21",
    answers: { used: 0, limit: 300 }, speech: { used: 0, limit: 100 }, yen: { used: 0, limit: 50 },
    reached: { answers: false, speech: false, yen: false },
  });
  const usage = (await a.getJson("/api/usage")).body;
  assert.equal(usage.daily.answers.limit, 300);
  assert.ok(usage.today && usage.total);
  const s = await beginSession(a);
  await a.postJson("/api/instant/answer", answerBody(s, 0, voiced()));
  const after = (await a.getJson("/api/usage")).body.daily;
  assert.equal(after.answers.used, 1);
  assert.ok(after.yen.used > 0 && after.yen.used < 1);
});

test("不正な vars（abc・0・999999・-1・空・小数）は既定になる", () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (const bad of ["abc", "0", "999999", "-1", "1.5", " 5", "５"]) {
      assert.deepEqual(guardConfig({ DAILY_ANSWER_LIMIT: bad, DAILY_YEN_LIMIT: bad, DAILY_SPEECH_LIMIT: bad, RATE_ANSWER_PER_MINUTE: bad, RATE_SPEECH_PER_MINUTE: bad }), GUARD_DEFAULTS, bad);
    }
    assert.deepEqual(guardConfig({}), GUARD_DEFAULTS);
    assert.deepEqual(guardConfig({ DAILY_ANSWER_LIMIT: "" }), GUARD_DEFAULTS);
    // 範囲の端
    assert.equal(guardConfig({ DAILY_ANSWER_LIMIT: "5000" }).dailyAnswers, 5000);
    assert.equal(guardConfig({ DAILY_ANSWER_LIMIT: "5001" }).dailyAnswers, 300);
    assert.equal(guardConfig({ DAILY_YEN_LIMIT: "10000" }).dailyYen, 10000);
    assert.equal(guardConfig({ DAILY_SPEECH_LIMIT: "2001" }).dailySpeech, 100);
    assert.equal(guardConfig({ RATE_ANSWER_PER_MINUTE: "600" }).rateAnswerPerMinute, 600);
    assert.equal(guardConfig({ RATE_SPEECH_PER_MINUTE: "601" }).rateSpeechPerMinute, 30);
  } finally { console.warn = originalWarn; }
});

test("reserveDaily：円が先に断る。7日より前の行は消える。メッセージの文言", () => {
  const db = migratedDb(T0);
  const cfg = { ...GUARD_DEFAULTS, dailyAnswers: 2, dailyYen: 10 };
  db.run("INSERT INTO daily_counters (day, name, count) VALUES ('2026-10-01', 'answer', 5), ('2026-10-15', 'answer', 5)");
  assert.deepEqual(reserveDaily(db, cfg, "answer", T0, 10), { ok: false, limit: "yen" });
  assert.deepEqual(reserveDaily(db, cfg, "answer", T0, 0), { ok: true });
  assert.deepEqual(db.all("SELECT day FROM daily_counters ORDER BY day").map((r) => r.day), ["2026-10-15", "2026-10-21"]); // 10-01 は消える（14日前）
  assert.deepEqual(reserveDaily(db, cfg, "answer", T0, 0), { ok: true });
  assert.deepEqual(reserveDaily(db, cfg, "answer", T0, 0), { ok: false, limit: "answers" });
  assert.deepEqual(reserveDaily(db, cfg, "speech", T0, 0), { ok: true }); // 読み上げは別の数
  assert.equal(dailyState(db, cfg, T0, 0).speech.used, 1);
  assert.match(dailyLimitMessage("answers", cfg), /^今日の採点の上限（2回）に達しました。/);
  db.close();
});
