// 受け口（/api/instant/*）を、DO の中の Hono をそのまま node:sqlite の上で動かして試す。外部へは通信しない（Gemini・Claude は偽物）。
// 元の試験は本物の Express を立てていた。今は makeApi（app.request で直に呼ぶ）。試験どうしが順に状態を引き継ぐ作りは元のまま
import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { instantQuestions } from "../src/server/instant/questions";
import { exportState } from "../src/server/instant/store";
import { buildWav, noise, silence, speechLike, toBase64, toWav } from "./helpers/wav-fixtures";
import { claudeMessage, clearAnswer, goodGrade, gradingUsage, uncertainAnswer } from "./helpers/fake-ai";
import { makeApi } from "./helpers/api";

forbidNetwork();
const api = makeApi();
const { ai, db, getJson, putJson, postJson } = api;
async function current() {
  let { body } = await getJson("/api/instant/status");
  if (!body.activeSession) body = (await postJson("/api/instant/start", { generationId: body.generationId })).body.session ? (await getJson("/api/instant/status")).body : body;
  return { sessionId: body.activeSession.id, questionId: body.activeSession.pendingQuestionIds[0] };
}
// 試験ごとに状態を分けるため、リセットしてから新しい出題を始める
async function freshSession() {
  await postJson("/api/instant/reset", {});
  const { body: status } = await getJson("/api/instant/status");
  const started = (await postJson("/api/instant/start", { generationId: status.generationId })).body.session;
  return { sessionId: started.id, pendingQuestionIds: started.pendingQuestionIds };
}
async function answer(audioBase64, mimeType = "audio/wav") { return postJson("/api/instant/answer", { ...await current(), mimeType, audioBase64 }); }
// 最初の答えが記録された問題（記録ファイルの先頭の回答）
async function currentAnsweredQuestion() { const saved = exportState(db); return { questionId: saved.attempts[0].questionId }; }
const speech = () => toBase64(toWav(speechLike()));
const quiet = () => toBase64(toWav(silence(2.2)));
const send = (session, questionId, audioBase64, extra = {}) => postJson("/api/instant/answer", { sessionId: session.sessionId, questionId, mimeType: "audio/wav", audioBase64, ...extra });

test("表が空でも、状態を2回読んで同じIDになり、そのIDで開始できる", async () => {
  assert.equal(db.all("SELECT * FROM instant_meta").length, 0); // まだ meta の行も無い
  const first = await getJson("/api/instant/status");
  const second = await getJson("/api/instant/status");
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.body.generationId, second.body.generationId);
  const started = await postJson("/api/instant/start", { generationId: first.body.generationId });
  assert.equal(started.status, 200);
  assert.equal(started.body.session.pendingQuestionIds.length, 10);
});

test("聞き取れた答えは200で記録される（Gemini は書き起こし、Claude が採点）", async () => {
  const before = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  const result = await answer(toBase64(toWav(speechLike())));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.attempt.passed, true);
  assert.equal(result.body.attempt.score, 95);
  assert.equal(result.body.summary.attempts, 1);
  assert.ok(result.body.audio.voicedSec >= 0.3);
  assert.equal(ai.geminiCalls.length, before + 1);
  assert.equal(ai.claudeCalls.length, claudeBefore + 1);
  assert.equal(ai.geminiCalls.at(-1).model, "gemini-3.5-transcribe");
  assert.equal(ai.geminiCalls.at(-1).input.length, 1); // 文字の指示は送らない
  assert.equal(ai.geminiCalls.at(-1).input[0].mime_type, "audio/wav");
  assert.equal(ai.geminiCalls.at(-1).store, false);
  const { questionId } = await currentAnsweredQuestion();
  const question = instantQuestions.find((item) => item.id === questionId);
  const geminiBody = JSON.stringify(ai.geminiCalls.at(-1));
  assert.ok(!geminiBody.includes(question.referenceAnswer) && !geminiBody.includes(question.japanese)); // 参考解答も日本語の問題も Gemini に渡さない
  const claudeText = ai.claudeCalls.at(-1).messages[0].content;
  const claudeUser = typeof claudeText === "string" ? claudeText : claudeText.map((block) => block.text).join("");
  assert.ok(claudeUser.includes("I'm a little tired today.") && claudeUser.includes(question.japanese));
  assert.equal(ai.claudeCalls.at(-1).model, "claude-haiku-5-5");
  const saved = exportState(db);
  assert.equal(saved.attempts[0].recognitionStatus, "clear");
  assert.equal(saved.attempts[0].model, "claude-haiku-5-5");
  assert.equal(saved.attempts[0].transcriptionModel, "gemini-3.5-transcribe");
  assert.equal(saved.attempts[0].rubricVersion, "instant-v3");
  assert.equal(saved.attempts[0].meaningEquivalent, true);
  assert.equal(saved.attempts[0].correctedAnswerEn, "I'm a little tired today.");
  assert.equal(saved.attempts[0].naturalAnswerEn, undefined);
  assert.equal(saved.attempts[0].score, 95);
  assert.equal((saved.attempts[0] as any).audio, undefined);
});

test("無音と小さな雑音は Gemini も Claude も呼ばずに422", async () => {
  const before = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  for (const samples of [silence(2.2), noise(3, 120, 7)]) {
    const result = await answer(toBase64(toWav(samples)));
    assert.equal(result.status, 422);
    assert.equal(result.body.error, "音声を検出できませんでした。もう一度話してください。");
    assert.equal(result.body.reason, "no_speech");
  }
  assert.equal(ai.geminiCalls.length, before);
  assert.equal(ai.claudeCalls.length, claudeBefore);
  assert.equal((await getJson("/api/instant/status")).body.attempts, 1);
});

test("WAV 以外や形式違いは400で Gemini を呼ばない", async () => {
  const before = ai.geminiCalls.length;
  const good = toBase64(toWav(speechLike()));
  const bodies = [
    answer(good, "audio/webm"),
    answer(toBase64(Buffer.alloc(3000, 7))),
    answer(toBase64(buildWav({ formatTag: 3, bitsPerSample: 32, data: Buffer.alloc(64000) }))),
    answer(toBase64(buildWav({ sampleRate: 44100, data: Buffer.alloc(88200) })))
  ];
  for (const result of await Promise.all(bodies)) assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(ai.geminiCalls.length, before);
});

test("聞き取り専用モデルが空を返したら422（empty）で、Claude を呼ばず記録も増えない", async () => {
  ai.geminiAnswer = uncertainAnswer;
  const claudeBefore = ai.claudeCalls.length;
  try {
    const result = await answer(toBase64(toWav(speechLike())));
    assert.equal(result.status, 422);
    assert.match(result.body.error, /音声を検出できませんでした/);
    assert.equal(result.body.reason, "empty");
  } finally { ai.geminiAnswer = clearAnswer; }
  assert.equal(ai.claudeCalls.length, claudeBefore);
  assert.equal((await getJson("/api/instant/status")).body.attempts, 1);
});

test("専用モデルが 429 で切り替え先が聞き取れないと答えたら422（uncertain）で、Claude を呼ばず記録も増えない", async () => {
  ai.geminiAnswer = uncertainAnswer;
  ai.geminiFailures = [429];
  const claudeBefore = ai.claudeCalls.length;
  const attemptsBefore = (await getJson("/api/instant/status")).body.attempts;
  const originalWarn = console.warn; console.warn = () => {};
  try {
    const result = await answer(toBase64(toWav(speechLike())));
    assert.equal(result.status, 422);
    assert.match(result.body.error, /聞き取れませんでした/);
    assert.equal(result.body.reason, "uncertain");
  } finally { ai.geminiAnswer = clearAnswer; ai.geminiFailures = []; console.warn = originalWarn; }
  assert.equal(ai.claudeCalls.length, claudeBefore);
  assert.equal((await getJson("/api/instant/status")).body.attempts, attemptsBefore);
});

test("古いセッションに無音を送ると、422 より 409 が先に返る", async () => {
  const before = ai.geminiCalls.length;
  const { questionId } = await current();
  const result = await postJson("/api/instant/answer", { sessionId: "no-such-session", questionId, mimeType: "audio/wav", audioBase64: toBase64(toWav(silence(2.2))) });
  assert.equal(result.status, 409);
  assert.equal(ai.geminiCalls.length, before);
});

test("時間切れ（timeout）の無音は、Gemini を呼ばずに「回答なし」の不合格として記録される", async () => {
  const session = await freshSession();
  const before = ai.geminiCalls.length;
  const result = await send(session, session.pendingQuestionIds[0], quiet(), { segmentEnd: "timeout" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.attempt.outcome, "no_answer");
  assert.equal(result.body.attempt.passed, false);
  assert.equal(result.body.attempt.score, 0);
  assert.equal(ai.geminiCalls.length, before);
  assert.equal(result.body.summary.attempts, 1);
});

test("停止（stopped）の無音は422で記録されず、不正な segmentEnd は400", async () => {
  const session = await freshSession();
  const stopped = await send(session, session.pendingQuestionIds[0], quiet(), { segmentEnd: "stopped" });
  assert.equal(stopped.status, 422);
  assert.equal(stopped.body.reason, "no_speech");
  const later = await send(session, session.pendingQuestionIds[0], quiet(), { segmentEnd: "later" });
  assert.equal(later.status, 400);
  assert.equal((await getJson("/api/instant/status")).body.attempts, 0);
});

test("順番が前後しても受け付け、同じ問題の2回目は409", async () => {
  const session = await freshSession();
  const [first, , third] = session.pendingQuestionIds;
  const a = await send(session, third, speech(), { segmentEnd: "timeout" });
  const b = await send(session, first, speech(), { segmentEnd: "timeout" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.session.answeredCount, 2);
  const again = await send(session, third, speech(), { segmentEnd: "timeout" });
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, "not_answerable");
});

test("finish：答えた分だけで終え、その後の答えは409、不明は404、reason が不正なら400", async () => {
  const session = await freshSession();
  await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
  await send(session, session.pendingQuestionIds[1], speech(), { segmentEnd: "timeout" });
  assert.equal((await postJson("/api/instant/finish", { sessionId: session.sessionId, reason: "later" })).status, 400);
  const finished = await postJson("/api/instant/finish", { sessionId: session.sessionId, reason: "stopped" });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.endedReason, "stopped");
  assert.equal(finished.body.items.length, 10);
  assert.equal(finished.body.items.filter((item) => item.attempt).length, 2);
  assert.equal(finished.body.items.filter((item) => item.attempt === null).length, 8);
  const late = await send(session, session.pendingQuestionIds[2], speech(), { segmentEnd: "timeout" });
  assert.equal(late.status, 409);
  const again = await postJson("/api/instant/finish", { sessionId: session.sessionId, reason: "stopped" });
  assert.equal(again.body.finishedAt, finished.body.finishedAt);
  assert.equal((await postJson("/api/instant/finish", { sessionId: "no-such-session", reason: "stopped" })).status, 404);
});

test("専用モデルの 500・429 はどちらも再送せず gemini-3.8-flash に切り替えて成功、両方 429 なら503（transcription_failed）で Claude を呼ばず記録が増えない", async () => {
  const session = await freshSession();
  const before = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  const originalWarn = console.warn; console.warn = () => {};
  try {
    ai.geminiFailures = [500];
    const retried = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(ai.geminiCalls.length, before + 2);
    assert.equal(ai.claudeCalls.length, claudeBefore + 1);
    ai.geminiFailures = [429];
    const switched = await send(session, session.pendingQuestionIds[1], speech(), { segmentEnd: "timeout" });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(ai.geminiCalls.length, before + 4);
    assert.equal(ai.geminiCalls.at(-1).model, "gemini-3.8-flash");
    assert.equal(ai.geminiCalls.at(-1).generation_config.thinking_level, "medium");
    assert.equal(ai.claudeCalls.length, claudeBefore + 2);
    const saved = exportState(db);
    const attempts = saved.attempts.filter((item) => item.sessionId === session.sessionId);
    assert.deepEqual(attempts.map((item) => item.transcriptionModel), ["gemini-3.8-flash", "gemini-3.8-flash"]);
    ai.geminiFailures = [429, 429];
    const limited = await send(session, session.pendingQuestionIds[2], speech(), { segmentEnd: "timeout" });
    assert.equal(limited.status, 503);
    assert.equal(limited.body.reason, "transcription_failed");
    assert.equal(ai.geminiCalls.length, before + 6);
    assert.equal(ai.claudeCalls.length, claudeBefore + 2);
  } finally { ai.geminiFailures = []; console.warn = originalWarn; }
});

test("Claude の 500 が続くと503（grading_failed）で、書き起こしを返し、記録は増えない", async () => {
  const session = await freshSession();
  const claudeBefore = ai.claudeCalls.length;
  ai.claudeFailures = [500, 500];
  const originalWarn = console.warn; console.warn = () => {};
  try {
    const failed = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.reason, "grading_failed");
    assert.equal(failed.body.transcript, "I'm a little tired today.");
    assert.equal(ai.claudeCalls.length, claudeBefore + 2);
    assert.equal((await getJson("/api/instant/status")).body.attempts, 0);
  } finally { ai.claudeFailures = []; console.warn = originalWarn; }
});

test("Claude の拒否は503（grading_refused）で、課金された使用量は記録される", async () => {
  const session = await freshSession();
  const read = async () => (await getJson("/api/usage")).body;
  const before = await read();
  ai.claudeReply = () => claudeMessage("", { stopReason: "refusal" });
  try {
    const refused = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.reason, "grading_refused");
    assert.equal(refused.body.transcript, "I'm a little tired today.");
  } finally { ai.claudeReply = () => claudeMessage(goodGrade()); }
  const after = await read();
  assert.equal(after.total.byProvider.claude.calls, before.total.byProvider.claude.calls + 1);
  assert.equal((await getJson("/api/instant/status")).body.attempts, 0);
});

test("Claude の形が不正（meaningPercent 101）なら503（grading_failed）で記録されない", async () => {
  const session = await freshSession();
  ai.claudeReply = () => claudeMessage({ ...goodGrade(), meaningPercent: 101 });
  try {
    const bad = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(bad.status, 503);
    assert.equal(bad.body.reason, "grading_failed");
  } finally { ai.claudeReply = () => claudeMessage(goodGrade()); }
  assert.equal((await getJson("/api/instant/status")).body.attempts, 0);
});

test("Claude のキーが無いと、status は claudeConfigured: false で、声のある答えは Gemini も呼ばずに503", async () => {
  const session = await freshSession();
  const geminiBefore = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  delete api.env.ANTHROPIC_API_KEY;
  try {
    const status = await getJson("/api/instant/status");
    assert.equal(status.body.claudeConfigured, false);
    assert.equal(status.body.geminiConfigured, true);
    const result = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(result.status, 503);
    assert.equal(result.body.reason, "grading_failed");
    assert.equal(ai.geminiCalls.length, geminiBefore);
    assert.equal(ai.claudeCalls.length, claudeBefore);
  } finally { api.env.ANTHROPIC_API_KEY = "test-only"; }
  assert.equal((await getJson("/api/instant/status")).body.claudeConfigured, true);
});

test("segmentEnd: next の無音は「回答なし」の不合格で記録され、外部 API を呼ばない。不正な値は400のまま", async () => {
  const session = await freshSession();
  const geminiBefore = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  const result = await send(session, session.pendingQuestionIds[0], quiet(), { segmentEnd: "next" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.attempt.outcome, "no_answer");
  assert.equal(result.body.attempt.passed, false);
  assert.equal(ai.geminiCalls.length, geminiBefore);
  assert.equal(ai.claudeCalls.length, claudeBefore);
  const saved = exportState(db);
  assert.equal(saved.attempts[0].reasonJa, "回答がないまま次の問題へ進みました。");
  assert.equal((await send(session, session.pendingQuestionIds[1], quiet(), { segmentEnd: "later" })).status, 400);
});

test("segmentEnd: next で声がある答えは、時間切れと同じく採点される", async () => {
  const session = await freshSession();
  const result = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "next" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.attempt.outcome, "answered");
  assert.equal(result.body.attempt.passed, true);
});

test("/api/usage：声のある答え1件で Gemini と Claude が1回ずつ増え、usage が欠けると Gemini の欠けだけ増え、無音では増えない", async () => {
  const session = await freshSession();
  const read = async () => (await getJson("/api/usage")).body;
  const base = await read();
  await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
  const one = await read();
  assert.equal(one.total.calls, base.total.calls + 2);
  assert.equal(one.total.byProvider.gemini.calls, base.total.byProvider.gemini.calls + 1);
  assert.equal(one.total.byProvider.claude.calls, base.total.byProvider.claude.calls + 1);
  assert.ok(Math.abs(one.total.usd - base.total.usd - (0.000758 + 0.00024)) < 1e-9); // 聞き取り専用モデル：(49×2.0 + (13+42)×12.0)/1e6
  ai.geminiUsage = undefined;
  try { await send(session, session.pendingQuestionIds[1], speech(), { segmentEnd: "timeout" }); } finally { ai.geminiUsage = gradingUsage; }
  const two = await read();
  assert.equal(two.total.calls, one.total.calls + 2);
  assert.equal(two.total.missingUsageCalls, one.total.missingUsageCalls + 1);
  assert.equal(two.total.byProvider.gemini.missingUsageCalls, one.total.byProvider.gemini.missingUsageCalls + 1);
  assert.equal(two.total.byProvider.claude.missingUsageCalls, one.total.byProvider.claude.missingUsageCalls);
  assert.ok(Math.abs(two.total.usd - one.total.usd - 0.00024) < 1e-9);
  await send(session, session.pendingQuestionIds[2], quiet(), { segmentEnd: "timeout" });
  assert.equal((await read()).total.calls, two.total.calls);
  assert.equal(two.usdJpy, 156);
  assert.ok(db.all("SELECT 1 FROM usage_days").length > 0); // 利用料は表に積まれる
});

test("設定の API：既定・保存・不正は400で前の値のまま・リセットでは消えない", async () => {
  assert.deepEqual((await getJson("/api/instant/settings")).body, { questionSeconds: 10, questionCount: 10 });
  const saved = await putJson("/api/instant/settings", { questionSeconds: 15, questionCount: 20 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { questionSeconds: 15, questionCount: 20 });
  assert.deepEqual((await getJson("/api/instant/settings")).body, { questionSeconds: 15, questionCount: 20 });
  assert.equal((await putJson("/api/instant/settings", { questionSeconds: 25, questionCount: 50 })).status, 200);
  for (const bad of [{ questionSeconds: "none", questionCount: 10 }, { questionSeconds: 9, questionCount: 10 }, { questionSeconds: 31, questionCount: 10 }, { questionSeconds: "20", questionCount: 10 }, { questionSeconds: null, questionCount: 10 }, { questionSeconds: 15, questionCount: 15 }, { questionSeconds: 15 }, {}]) {
    const result = await putJson("/api/instant/settings", bad);
    assert.equal(result.status, 400, JSON.stringify(bad));
    assert.match(result.body.error, /10〜30秒/);
  }
  assert.deepEqual((await getJson("/api/instant/settings")).body, { questionSeconds: 25, questionCount: 50 });
  await postJson("/api/instant/reset", {});
  assert.deepEqual((await getJson("/api/instant/settings")).body, { questionSeconds: 25, questionCount: 50 });
});

test("start：問題数と1問の時間。不正は400で出題を作らない。何も渡さなければ10問", async () => {
  await postJson("/api/instant/reset", {});
  const { body: status } = await getJson("/api/instant/status");
  const started = await postJson("/api/instant/start", { generationId: status.generationId, questionCount: 20, questionSeconds: 15 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.session.total, 20);
  const saved = exportState(db);
  assert.equal(saved.sessions[0].questionSeconds, 15);
  for (const body of [{ questionCount: 15 }, { questionCount: "20" }, { questionCount: null }, { questionCount: 100 }, { questionSeconds: 9 }]) {
    await postJson("/api/instant/reset", {});
    const { body: fresh } = await getJson("/api/instant/status");
    const result = await postJson("/api/instant/start", { generationId: fresh.generationId, ...body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal((await getJson("/api/instant/status")).body.activeSession, null);
  }
  await postJson("/api/instant/reset", {});
  const { body: last } = await getJson("/api/instant/status");
  assert.equal((await postJson("/api/instant/start", { generationId: last.generationId })).body.session.total, 10);
});

test("意味は伝わっても77点なら不合格（連続合格は0）で、記録と結果に meaningEquivalent が残る", async () => {
  const session = await freshSession();
  ai.claudeReply = () => claudeMessage({ ...goodGrade(), meaningEquivalent: true, meaningPercent: 90, grammarScore: 5 });
  try {
    const result = await send(session, session.pendingQuestionIds[0], speech(), { segmentEnd: "timeout" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.attempt.passed, false);
    assert.equal(result.body.attempt.score, 77);
    assert.equal(result.body.attempt.consecutivePasses, 0);
  } finally { ai.claudeReply = () => claudeMessage(goodGrade()); }
  const saved = exportState(db);
  assert.equal(saved.attempts[0].meaningEquivalent, true);
  assert.equal(saved.attempts[0].rubricVersion, "instant-v3");
  const finished = await postJson("/api/instant/finish", { sessionId: session.sessionId, reason: "stopped" });
  assert.equal(finished.body.items.find((item) => item.attempt)?.attempt.meaningEquivalent, true);
});

test("60秒の WAV（1区間の録音の最長）は受け付け、声が無ければ Gemini も Claude も呼ばずに回答なし", async () => {
  const session = await freshSession();
  const geminiBefore = ai.geminiCalls.length; const claudeBefore = ai.claudeCalls.length;
  const result = await send(session, session.pendingQuestionIds[0], toBase64(toWav(silence(60))), { segmentEnd: "timeout" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.attempt.outcome, "no_answer");
  assert.equal(ai.geminiCalls.length, geminiBefore);
  assert.equal(ai.claudeCalls.length, claudeBefore);
});

test("65秒までは通り、65.5秒は「録音が長すぎます」、66秒は形式の不正で、どれも Gemini を呼ばない", async () => {
  const session = await freshSession();
  const geminiBefore = ai.geminiCalls.length;
  const ok = await send(session, session.pendingQuestionIds[0], toBase64(toWav(silence(65))), { segmentEnd: "timeout" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const tooLong = await send(session, session.pendingQuestionIds[1], toBase64(toWav(silence(65.5))), { segmentEnd: "timeout" });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /1問の録音は60秒まで/);
  const way = await send(session, session.pendingQuestionIds[1], toBase64(toWav(silence(66))), { segmentEnd: "timeout" });
  assert.equal(way.status, 400);
  assert.equal(way.body.error, "録音データの形式が正しくありません。");
  assert.equal(ai.geminiCalls.length, geminiBefore);
});

// ---- Workers 化で足した試験（新しい makeApi で、ほかの試験の状態に頼らない）----
async function startedSession(a = makeApi()) {
  const { body: status } = await a.getJson("/api/instant/status");
  const { body } = await a.postJson("/api/instant/start", { generationId: status.generationId });
  return { a, sessionId: body.session.id as string, ids: body.session.pendingQuestionIds as string[] };
}

test("health：アプリ名と DB の版を返す。知らない道筋は404の JSON", async () => {
  const a = makeApi();
  const health = await a.getJson("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, app: "speak25", schemaVersion: 3 });
  const missing = await a.getJson("/api/nothing");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "見つかりません。", reason: "not_found" });
  const wrongMethod = await a.postJson("/api/health", {});
  assert.equal(wrongMethod.status, 404);
});

test("no-answer：timeout・next は回答なしの不合格として記録され、外部 API を呼ばず、audio は付かない", async () => {
  const { a, sessionId, ids } = await startedSession();
  const timeout = await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[0], segmentEnd: "timeout" });
  assert.equal(timeout.status, 200, JSON.stringify(timeout.body));
  assert.equal(timeout.body.attempt.outcome, "no_answer");
  assert.equal(timeout.body.attempt.passed, false);
  assert.equal(timeout.body.attempt.score, 0);
  assert.equal(timeout.body.attempt.consecutivePasses, 0);
  assert.equal(timeout.body.summary.attempts, 1);
  assert.equal("audio" in timeout.body, false);
  const next = await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[1], segmentEnd: "next" });
  assert.equal(next.status, 200);
  const rows = exportState(a.db).attempts;
  assert.deepEqual(rows.map((row) => row.reasonJa), ["時間内に回答がありませんでした。", "回答がないまま次の問題へ進みました。"]);
  assert.ok(rows.every((row) => row.recognitionStatus === "no_speech" && row.correctedAnswerEn === "" && row.model === null && row.rubricVersion === "instant-v3"));
  assert.equal(a.ai.geminiCalls.length + a.ai.claudeCalls.length, 0);
  assert.equal(a.db.all("SELECT * FROM usage_days").length, 0); // 費用は発生しない
});

test("no-answer の回答なしは、サーバーが声なしの WAV から作る回答なしと同じ中身になる", async () => {
  const { a, sessionId, ids } = await startedSession();
  const viaWav = await a.postJson("/api/instant/answer", { sessionId, questionId: ids[0], mimeType: "audio/wav", audioBase64: toBase64(toWav(silence(2.2))), segmentEnd: "timeout" });
  const viaNoAnswer = await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[1], segmentEnd: "timeout" });
  const [x, y] = exportState(a.db).attempts as any[];
  const strip = ({ id, questionId, createdAt, ...rest }: any) => rest;
  assert.deepEqual(strip(x), strip(y));
  assert.equal(viaWav.body.attempt.outcome, viaNoAnswer.body.attempt.outcome);
});

test("no-answer：記録済み・別の出題は409、stopped・未知の問題・形の違いは400（記録は増えない）", async () => {
  const { a, sessionId, ids } = await startedSession();
  assert.equal((await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[0], segmentEnd: "timeout" })).status, 200);
  const again = await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[0], segmentEnd: "timeout" });
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, "not_answerable");
  assert.equal((await a.postJson("/api/instant/no-answer", { sessionId: "no-such-session", questionId: ids[1], segmentEnd: "timeout" })).status, 409);
  const notInSession = instantQuestions.find((q) => !ids.includes(q.id)).id;
  assert.equal((await a.postJson("/api/instant/no-answer", { sessionId, questionId: notInSession, segmentEnd: "timeout" })).status, 409);
  for (const bad of [{ segmentEnd: "stopped" }, { segmentEnd: "later" }, {}, { segmentEnd: 1 }]) {
    const result = await a.postJson("/api/instant/no-answer", { sessionId, questionId: ids[2], ...bad });
    assert.equal(result.status, 400, JSON.stringify(bad));
    assert.equal(result.body.error, "回答なしの指定が正しくありません。");
  }
  assert.equal((await a.postJson("/api/instant/no-answer", { sessionId, questionId: "q999", segmentEnd: "timeout" })).status, 400);
  assert.equal((await a.postJson("/api/instant/no-answer", { questionId: ids[2], segmentEnd: "timeout" })).status, 400);
  assert.equal((await a.getJson("/api/instant/status")).body.attempts, 1);
});

test("本文が上限を超えると413：answer は 4,194,304 バイト、そのほかは 61,440 バイト。上限ちょうどは通る", async () => {
  const { a, sessionId, ids } = await startedSession();
  const bigAnswer = `{"sessionId":"${sessionId}","questionId":"${ids[0]}","pad":"${"x".repeat(4_194_304)}"}`;
  const tooBig = await a.app.request("/api/instant/answer", { method: "POST", headers: { "content-type": "application/json" }, body: bigAnswer });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: "送られたデータが大きすぎます。", reason: "too_large" });
  const bigSettings = await a.app.request("/api/instant/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionSeconds: 10, questionCount: 10, pad: "x".repeat(61_440) }) });
  assert.equal(bigSettings.status, 413);
  const bigStart = await a.app.request("/api/instant/start", { method: "POST", headers: { "content-type": "application/json" }, body: `{"pad":"${"x".repeat(61_440)}"}` });
  assert.equal(bigStart.status, 413);
  // 上限ちょうど（61,440バイト）は通る
  const prefix = '{"questionSeconds":10,"questionCount":10,"pad":"';
  const exact = prefix + "x".repeat(61_440 - prefix.length - 2) + '"}';
  assert.equal(new TextEncoder().encode(exact).length, 61_440);
  const ok = await a.app.request("/api/instant/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: exact });
  assert.equal(ok.status, 200);
  // JSON でない・配列は400
  for (const body of ["not json", "[1]", "null"]) {
    const bad = await a.app.request("/api/instant/start", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(bad.status, 400, body);
  }
  // Content-Length を付けずに流す本文（ストリーム）でも、超えたら途中で止まる
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; if (pulled > 100) controller.close(); else controller.enqueue(new Uint8Array(1024)); } });
  const streamed = await a.app.request(new Request("http://localhost/api/instant/settings", { method: "PUT", body: stream, duplex: "half", headers: { "content-type": "application/json" } } as RequestInit));
  assert.equal(streamed.status, 413);
  assert.ok(pulled < 100, `読みすぎた: ${pulled}`);
});

test("読み上げ：模範文を WAV で返し（Uint8Array → Response）、日本語の問題文も読める。キーが無ければ503", async () => {
  const { a, sessionId, ids } = await startedSession();
  await a.postJson("/api/instant/finish", { sessionId, reason: "stopped" });
  const response = await a.app.request("/api/instant/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionId: ids[0] }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
  assert.equal(a.ai.geminiCalls.at(-1).model, "gemini-3.8-flash-tts");
  const prompt = await a.app.request("/api/instant/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionId: ids[0], kind: "prompt" }) });
  assert.equal(prompt.status, 200);
  assert.match(JSON.stringify(a.ai.geminiCalls.at(-1)), /Japanese/);
  delete a.env.GEMINI_API_KEY;
  const noKey = await a.postJson("/api/instant/speech", { questionId: ids[0] });
  assert.equal(noKey.status, 503);
  assert.match(noKey.body.error, /Variables and Secrets/);
});
