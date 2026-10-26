import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { instantQuestions } from "../src/server/instant/questions";
import { createInstantStore, exportState, importState, noAnswerEvaluation } from "../src/server/instant/store";
import { cryptoRandomInt } from "../src/server/random";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);

const evaluation = (passed = true) => ({ recognitionStatus: "clear", transcript: "I'm fine, thanks.", meaningScore: passed ? 78 : 10, grammarScore: 18, score: passed ? 96 : 28, passed, reasonJa: "意味が伝わります。", grammarFeedbackJa: "自然です。", naturalAnswerEn: "I'm doing well, thanks.", model: "test", rubricVersion: "test-v1" });
// 元の試験は一時ファイルの上に store を作っていた。今は node:sqlite（:memory:）の上に作る。db を渡せば「再起動」（同じ表に store を作り直す）もできる
function fixture(existing?: ReturnType<typeof migratedDb>) {
  const db = existing ?? migratedDb(NOW);
  const clock = { t: NOW };
  return { db, clock, store: createInstantStore({ db, now: () => clock.t, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" }) };
}

test("教材は分野ごと10問で計100問、IDに重複がない", () => {
  assert.equal(instantQuestions.length, 100);
  assert.equal(new Set(instantQuestions.map((q) => q.id)).size, 100);
  assert.deepEqual([...new Set(instantQuestions.map((q) => q.category))].map((category) => instantQuestions.filter((q) => q.category === category).length), Array(10).fill(10));
  assert.ok(instantQuestions.every((q) => q.japanese && q.referenceAnswer && q.meaningRequirements));
});

test("開始時は未クリアから重複しない10問を選び、進行中は同じ問題へ戻る", async () => {
  const { store } = fixture();
  const started = await store.start();
  assert.equal(started.session.total, 10);
  assert.equal(started.session.questions.length, 10);
  assert.equal(started.session.pendingQuestionIds.length, 10);
  assert.equal(new Set(started.session.pendingQuestionIds).size, 10);
  assert.equal(started.session.answeredCount, 0);
  assert.equal((started as any).summary, undefined);
  assert.equal(started.resumed, false);
  const again = await store.start();
  assert.equal(again.resumed, true);
  assert.equal(again.session.id, started.session.id);
  assert.deepEqual(again.session.pendingQuestionIds, started.session.pendingQuestionIds);
});

test("3連続合格でクリア、不合格で連続記録が0に戻る", async () => {
  const { db, store } = fixture();
  const questionIds = instantQuestions.slice(0, 10).map((q) => q.id);
  const state = { schemaVersion: 1, generationId: "gen-1", sessions: [{ id: "s-1", generationId: "gen-1", questionIds, index: 0, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: null }], attempts: [], progress: { q001: { consecutivePasses: 2, clearedAt: null }, q002: { consecutivePasses: 2, clearedAt: null } } };
  importState(db, state, NOW);
  const before = await store.checkAnswerable("s-1", "q001");
  const first = await store.record("s-1", "q001", before, evaluation(true));
  assert.equal(first.attempt.consecutivePasses, 3);
  assert.equal(first.summary.cleared, 1);
  assert.equal(await store.record("s-1", "q001", before, evaluation(true)), null);
  const second = await store.record("s-1", "q002", await store.checkAnswerable("s-1", "q002"), evaluation(false));
  assert.equal(second.attempt.consecutivePasses, 0);
  assert.equal(second.summary.attempts, 2);
  const saved = exportState(db);
  assert.equal(saved.attempts.length, 2);
  assert.ok(saved.progress.q001.clearedAt);
});

test("クリア済みを出題から外し、残り9問なら9問にする", async () => {
  const { db, store } = fixture();
  const progress = Object.fromEntries(instantQuestions.slice(0, 91).map((q) => [q.id, { consecutivePasses: 3, clearedAt: "2026-10-19T00:00:00.000Z" }]));
  importState(db, { schemaVersion: 1, generationId: "gen-1", sessions: [], attempts: [], progress }, NOW);
  const started = await store.start();
  assert.equal(started.session.total, 9);
  assert.ok(started.session.questions.every((question) => instantQuestions.slice(91).some((q) => q.id === question.id)));
});

test("リセット前の採点は書き戻せず、回答履歴は消える", async () => {
  const { store } = fixture();
  const started = await store.start();
  const sessionId = started.session.id; const questionId = started.session.pendingQuestionIds[0];
  const expected = await store.checkAnswerable(sessionId, questionId);
  await store.reset();
  assert.equal(await store.record(sessionId, questionId, expected, evaluation()), null);
  const status = await store.status();
  assert.equal(status.attempts, 0);
  assert.equal(status.activeSession, null);
});

test("リセット前の開始リクエストは新しい記録にセッションを作れない", async () => {
  const { store } = fixture();
  const previous = await store.status();
  await store.reset();
  assert.throws(() => store.start(previous.generationId), { status: 409 }); // 同期の関数なので、rejects ではなく throws
  assert.equal((await store.status()).activeSession, null);
});

test("記録ファイルが無くても、状態を2回読んで同じIDになり、そのIDで開始できる", async () => {
  const { db, store } = fixture();
  const first = await store.status();
  const second = await store.status();
  assert.equal(first.generationId, second.generationId);
  assert.equal(db.all("SELECT generation_id FROM instant_meta").length, 1); // 状態を読んだ時点で meta の行ができている
  const restarted = fixture(db).store; // 同じ表の上に作り直す（再起動）
  assert.equal((await restarted.status()).generationId, first.generationId);
  const started = await store.start(first.generationId);
  assert.ok(started.session);
  assert.equal(started.generationId, first.generationId);
});

// ---- 自動進行（順番を問わない記録・回答なし・停止）----
const sessionState = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, generationId: "gen-1", sessions: [{ id: "s-1", generationId: "gen-1", questionIds: instantQuestions.slice(0, 3).map((q) => q.id), index: 0, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: null, endedReason: null }], attempts: [], progress: {}, ...overrides });
function seeded(state: unknown) { const made = fixture(); importState(made.db, state, NOW); return made; }
async function recordAnswer(store: ReturnType<typeof fixture>["store"], sessionId: string, questionId: string, passed = true) { return store.record(sessionId, questionId, (await store.checkAnswerable(sessionId, questionId))!, evaluation(passed))!; }

test("順番が前後した答えを記録でき、答え合わせは出題順に並ぶ", async () => {
  const { store } = await seeded(sessionState());
  const first = await recordAnswer(store, "s-1", "q003");
  assert.equal(first.session.answeredCount, 1);
  assert.deepEqual(first.session.pendingQuestionIds, ["q001", "q002"]);
  assert.equal(first.completed, false);
  assert.equal(first.attempt.questionId, "q003");
  assert.equal(first.attempt.outcome, "answered");
  const second = await recordAnswer(store, "s-1", "q001");
  assert.deepEqual(second.session.pendingQuestionIds, ["q002"]);
  const third = await recordAnswer(store, "s-1", "q002");
  assert.equal(third.completed, true);
  assert.equal(third.session.pendingQuestionIds.length, 0);
  const results = await store.results("s-1");
  assert.equal(results.endedReason, "completed");
  assert.deepEqual(results.items.map((item) => item.question.id), ["q001", "q002", "q003"]);
  assert.ok(results.items.every((item) => item.attempt));
});

test("同じ問題の2回目と、セッションに無い問題は受け付けない", async () => {
  const { store } = await seeded(sessionState());
  const expected = await store.checkAnswerable("s-1", "q002");
  assert.ok(await store.record("s-1", "q002", expected, evaluation()));
  assert.equal(await store.checkAnswerable("s-1", "q002"), null);
  assert.equal(await store.record("s-1", "q002", expected, evaluation()), null);
  assert.equal(await store.checkAnswerable("s-1", "q050"), null);
  assert.equal(await store.record("s-1", "q050", expected, evaluation()), null);
});

test("時間内に回答なしは不合格で記録され、連続合格が0に戻る", async () => {
  const { db, store } = await seeded(sessionState({ progress: { q001: { consecutivePasses: 2, clearedAt: null } } }));
  const recorded = await store.record("s-1", "q001", await store.checkAnswerable("s-1", "q001"), noAnswerEvaluation());
  assert.equal(recorded.attempt.passed, false);
  assert.equal(recorded.attempt.score, 0);
  assert.equal(recorded.attempt.consecutivePasses, 0);
  assert.equal(recorded.attempt.outcome, "no_answer");
  const saved = exportState(db);
  assert.equal(saved.attempts[0].recognitionStatus, "no_speech");
  assert.equal(saved.attempts[0].reasonJa, "時間内に回答がありませんでした。");
  assert.equal(saved.progress.q001.consecutivePasses, 0);
});

test("停止：答えた分だけで終わり、その後は受け付けず、2回呼んでも同じ", async () => {
  const questionIds = instantQuestions.slice(0, 10).map((q) => q.id);
  const { store } = await seeded(sessionState({ sessions: [{ id: "s-1", generationId: "gen-1", questionIds, index: 0, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: null, endedReason: null }] }));
  await recordAnswer(store, "s-1", "q001");
  await recordAnswer(store, "s-1", "q002", false);
  const stopped = await store.finish("s-1", "stopped");
  assert.equal(stopped.endedReason, "stopped");
  assert.equal(stopped.items.length, 10);
  assert.equal(stopped.items.filter((item) => item.attempt).length, 2);
  assert.equal(stopped.items.filter((item) => item.attempt === null).length, 8);
  assert.equal((await store.status()).activeSession, null);
  assert.equal(await store.checkAnswerable("s-1", "q003"), null);
  assert.equal(await store.record("s-1", "q003", { generationId: "gen-1" }, evaluation()), null);
  const again = await store.finish("s-1", "stopped");
  assert.equal(again.finishedAt, stopped.finishedAt);
  // 全部答えた後の finish は、reason が stopped でも completed になる
  const full = await seeded(sessionState());
  for (const id of ["q001", "q002", "q003"]) { const inner = await full.store.checkAnswerable("s-1", id); if (inner) await full.store.record("s-1", id, inner, evaluation()); }
  // record が全問で自動的に終えるので、finish は終了済みの結果をそのまま返す
  assert.equal((await full.store.finish("s-1", "stopped")).endedReason, "completed");
  // 全部答えているが、まだ終わっていないセッション（記録の途中で落ちた場合など）
  const unfinished = await seeded(sessionState({ attempts: ["q001", "q002", "q003"].map((id) => ({ id: `a-${id}`, sessionId: "s-1", questionId: id, createdAt: "2026-10-20T00:00:00.000Z", ...evaluation(), consecutivePasses: 1 })) }));
  assert.equal((await unfinished.store.finish("s-1", "stopped")).endedReason, "completed");
});

test("finish は、不明なセッションとリセットの後は null", async () => {
  const { store } = await seeded(sessionState());
  assert.equal(await store.finish("no-such", "stopped"), null);
  await store.reset();
  assert.equal(await store.finish("s-1", "stopped"), null);
});

test("昨日までの形の記録ファイルをそのまま読める", async () => {
  const ids = instantQuestions.slice(0, 10).map((q) => q.id);
  const done = { id: "s-old", generationId: "gen-1", questionIds: instantQuestions.slice(10, 20).map((q) => q.id), index: 10, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: "2026-10-19T00:10:00.000Z" };
  const midway = { id: "s-mid", generationId: "gen-1", questionIds: ids, index: 3, startedAt: "2026-10-19T01:00:00.000Z", finishedAt: null };
  const attempt = (sessionId, questionId) => ({ id: `a-${sessionId}-${questionId}`, sessionId, questionId, createdAt: "2026-10-19T00:00:00.000Z", recognitionStatus: "clear", transcript: "x", meaningScore: 70, grammarScore: 20, score: 90, passed: true, reasonJa: "良い", grammarFeedbackJa: "", naturalAnswerEn: "x", model: "m", rubricVersion: "instant-v1", consecutivePasses: 1 });
  const attempts = [...done.questionIds.map((id) => attempt("s-old", id)), ...ids.slice(0, 3).map((id) => attempt("s-mid", id))];
  const { store } = await seeded({ schemaVersion: 1, generationId: "gen-1", sessions: [done, midway], attempts, progress: {} });
  const status = await store.status();
  assert.deepEqual(status.activeSession.pendingQuestionIds, ids.slice(3));
  assert.equal(status.activeSession.answeredCount, 3);
  const results = await store.results("s-old");
  assert.equal(results.endedReason, "completed");
  assert.equal(results.items.length, 10);
  assert.equal(results.questionSeconds, undefined);
  assert.equal((await store.start()).session.id, "s-mid");
});

test("読み上げ：終わった出題の問題なら、回答が無くても模範文を読める", async () => {
  const q = (n) => `q${String(n).padStart(3, "0")}`;
  const state = sessionState({
    sessions: [
      { id: "s-end", generationId: "gen-1", questionIds: [q(1), q(2)], index: 1, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:01:00.000Z", endedReason: "stopped" },
      { id: "s-run", generationId: "gen-1", questionIds: [q(5)], index: 0, startedAt: "2026-10-20T00:02:00.000Z", finishedAt: null, endedReason: null }
    ],
    attempts: [{ id: "a-1", sessionId: "s-end", questionId: q(1), createdAt: "2026-10-20T00:00:30.000Z", ...evaluation(), consecutivePasses: 1 }, { id: "a-2", sessionId: "s-end", questionId: q(2), createdAt: "2026-10-20T00:00:40.000Z", ...noAnswerEvaluation(), consecutivePasses: 0 }]
  });
  const { store } = await seeded(state);
  assert.equal(await store.speechText(q(2), undefined, false), instantQuestions[1].referenceAnswer);
  assert.equal(await store.speechText(q(3), undefined, false), null); // 出題されていない
  assert.equal(await store.speechText(q(5), undefined, false), null); // 進行中の出題にだけある
  assert.equal(await store.speechText(q(1), "a-1", false), "I'm doing well, thanks.");
  assert.equal(await store.speechText(q(2), "a-2", false), null); // 回答なしは自然な言い方が無い
  assert.equal(await store.speechText(q(5), undefined, true), instantQuestions[4].japanese); // 日本語の問題文はいつでも
});

test("noAnswerEvaluation：next は「次の問題へ進みました」、既定は今の文言、版は instant-v3", () => {
  assert.equal(noAnswerEvaluation("next").reasonJa, "回答がないまま次の問題へ進みました。");
  assert.equal(noAnswerEvaluation("timeout").reasonJa, "時間内に回答がありませんでした。");
  assert.equal(noAnswerEvaluation().reasonJa, "時間内に回答がありませんでした。");
  assert.equal(noAnswerEvaluation("next").rubricVersion, "instant-v3");
  assert.equal(noAnswerEvaluation().correctedAnswerEn, "");
  assert.equal(noAnswerEvaluation().outcome, "no_answer");
});

test("問題数 10・20・30・50 で、その数だけ重複なく出題の中から選ぶ", async () => {
  const ids = new Set(instantQuestions.map((q) => q.id));
  for (const count of [10, 20, 30, 50]) {
    const { store } = fixture();
    const started = await store.start(undefined, { questionCount: count });
    assert.equal(started.session.total, count);
    assert.equal(new Set(started.session.pendingQuestionIds).size, count);
    assert.ok(started.session.pendingQuestionIds.every((id) => ids.has(id)));
  }
  const { store } = fixture();
  assert.equal((await store.start(undefined, { questionCount: 15 })).session.total, 10); // 不正な数は既定（API の入口で400にする）
});

test("未クリアが少なければ残り全部、全部クリア済みなら session は null", async () => {
  const { db, store } = fixture();
  const progress = Object.fromEntries(instantQuestions.slice(0, 93).map((q) => [q.id, { consecutivePasses: 3, clearedAt: "2026-10-19T00:00:00.000Z" }]));
  importState(db, { schemaVersion: 1, generationId: "gen-1", sessions: [], attempts: [], progress }, NOW);
  const started = await store.start(undefined, { questionCount: 20 });
  assert.equal(started.session.total, 7);
  assert.equal(started.resumed, false);
  const all = fixture();
  const full = Object.fromEntries(instantQuestions.map((q) => [q.id, { consecutivePasses: 3, clearedAt: "2026-10-19T00:00:00.000Z" }]));
  importState(all.db, { schemaVersion: 1, generationId: "gen-1", sessions: [], attempts: [], progress: full }, NOW);
  const none = await all.store.start(undefined, { questionCount: 20 });
  assert.equal(none.session, null);
  assert.equal(none.resumed, false);
});

test("途中の出題があれば新しい問題数は使わず、同じ問題で続ける", async () => {
  const { store } = fixture();
  const first = await store.start(undefined, { questionCount: 20 });
  const second = await store.start(undefined, { questionCount: 50 });
  assert.equal(second.resumed, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.total, 20);
  assert.deepEqual(second.session.pendingQuestionIds, first.session.pendingQuestionIds);
});

test("1問の時間は session に記録され、続きから始めると書き換わり、結果にも出る。渡さなければ項目なし", async () => {
  const { db, store } = fixture();
  const first = await store.start(undefined, { questionCount: 10, questionSeconds: 20 });
  let saved = exportState(db);
  assert.equal(saved.sessions[0].questionSeconds, 20);
  await store.start(undefined, { questionSeconds: 25 });
  saved = exportState(db);
  assert.equal(saved.sessions[0].questionSeconds, 25);
  await store.start(undefined, { questionSeconds: 99 as any }); // 不正は書き換えない
  await store.start(undefined, { questionSeconds: "none" as any }); // 制限なしはもう受け付けない（書き換えない）
  saved = exportState(db);
  assert.equal(saved.sessions[0].questionSeconds, 25);
  const finished = await store.finish(first.session.id, "stopped");
  assert.equal(finished.questionSeconds, 25);
  assert.equal((await store.results(first.session.id)).questionSeconds, 25);
  const other = fixture();
  await other.store.start(undefined, { questionSeconds: 99 });
  const noRecord = exportState(other.db);
  assert.equal("questionSeconds" in noRecord.sessions[0], false);
});

test("前の版が 'none'（制限なし）で記録した途中の回を続きから始めても壊れず、渡された秒数（今の設定）に書き換わる", async () => {
  const { db, store } = fixture();
  const first = await store.start(undefined, { questionCount: 10, questionSeconds: 20 });
  db.run("UPDATE instant_sessions SET question_seconds = 'none'");
  const resumed = await store.start(undefined, { questionSeconds: 12 });
  assert.equal(resumed.resumed, true);
  assert.equal(exportState(db).sessions[0].questionSeconds, 12);
  // 秒数が渡されない続きは 'none' のまま残るが、読むと項目なしになり壊れない
  db.run("UPDATE instant_sessions SET question_seconds = 'none'");
  assert.equal((await store.start(undefined, {})).resumed, true);
  assert.equal("questionSeconds" in exportState(db).sessions[0], false);
  await store.finish(first.session.id, "stopped");
  assert.equal((await store.results(first.session.id)).questionSeconds, undefined);
});

test("読み上げ：直した文（correctedAnswerEn）を読み、古い記録は naturalAnswerEn を読む", async () => {
  const { store } = fixture();
  const started = await store.start();
  const [a, b] = started.session.pendingQuestionIds;
  const ready = await store.checkAnswerable(started.session.id, a);
  await store.record(started.session.id, a, ready, { ...evaluation(), naturalAnswerEn: undefined, correctedAnswerEn: "I'm doing great." });
  await store.record(started.session.id, b, await store.checkAnswerable(started.session.id, b), evaluation());
  await store.finish(started.session.id, "stopped");
  const saved = (await store.history()).progress;
  const idOf = (questionId) => saved.find((row) => row.question.id === questionId).attempts[0].id;
  assert.equal(await store.speechText(a, idOf(a), false), "I'm doing great.");
  assert.equal(await store.speechText(b, idOf(b), false), "I'm doing well, thanks.");
});


// ---- DO の SQLite 化で足した試験 ----
test("exportState → importState → exportState が同じになる（元の JSON の形の往復）", async () => {
  const { db, store } = fixture();
  const started = store.start(undefined, { questionCount: 10, questionSeconds: 20 });
  const [a, b, c] = started.session.pendingQuestionIds;
  await recordAnswer(store, started.session.id, a);
  await recordAnswer(store, started.session.id, b, false);
  store.record(started.session.id, c, store.checkAnswerable(started.session.id, c), noAnswerEvaluation("next"));
  store.finish(started.session.id, "stopped");
  store.start(undefined, { questionCount: 20 }); // 次の出題（進行中）
  const first = exportState(db);
  assert.equal(first.sessions.length, 2);
  assert.equal(first.attempts.length, 3);
  const other = fixture();
  importState(other.db, first, NOW);
  assert.deepEqual(exportState(other.db), first);
  assert.deepEqual(other.store.status(), store.status()); // 画面に出る状態も同じ
});

test("attempt_count は record で増え、reset で0に戻る。数は meta の列で数える", async () => {
  const { db, store } = fixture();
  const started = store.start();
  assert.equal(Number(db.all("SELECT attempt_count FROM instant_meta")[0].attempt_count), 0);
  await recordAnswer(store, started.session.id, started.session.pendingQuestionIds[0]);
  await recordAnswer(store, started.session.id, started.session.pendingQuestionIds[1], false);
  assert.equal(Number(db.all("SELECT attempt_count FROM instant_meta")[0].attempt_count), 2);
  assert.equal(store.status().attempts, 2);
  const before = store.status().generationId;
  const reset = store.reset();
  assert.equal(reset.attempts, 0);
  assert.notEqual(reset.generationId, before);
  assert.equal(Number(db.all("SELECT attempt_count FROM instant_meta")[0].attempt_count), 0);
  assert.equal(db.all("SELECT * FROM instant_attempts").length + db.all("SELECT * FROM instant_sessions").length + db.all("SELECT * FROM instant_progress").length, 0);
});

test("record の途中で例外が起きたら、進捗・回答・件数のどれも残らない", async () => {
  const { db, store } = fixture();
  const started = store.start();
  const id = started.session.pendingQuestionIds[0];
  const expected = store.checkAnswerable(started.session.id, id);
  // 2つ目以降の書き込み（回答の INSERT）で落ちる Db に包んで、同じ表の上に store を作る
  let writes = 0;
  const failing = {
    all: (q: string, ...p: any[]) => db.all(q, ...p),
    run: (q: string, ...p: any[]) => { writes += 1; if (writes === 2) throw new Error("disk full"); db.run(q, ...p); },
    transaction: <T,>(fn: () => T) => db.transaction(fn),
  };
  const broken = createInstantStore({ db: failing, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" });
  assert.throws(() => broken.record(started.session.id, id, expected, evaluation(true)), /disk full/);
  assert.equal(db.all("SELECT * FROM instant_attempts").length, 0);
  assert.equal(db.all("SELECT * FROM instant_progress").length, 0);
  assert.equal(Number(db.all("SELECT attempt_count FROM instant_meta")[0].attempt_count), 0);
  assert.ok(store.record(started.session.id, id, expected, evaluation(true))); // 失敗の後でも同じ問題を記録できる
});

test("回答の JSON の項目の規則：NULL の項目は出さない・空の文字は空の文字のまま・model は null のまま", async () => {
  const { store } = fixture();
  const started = store.start();
  const [a, b, c] = started.session.pendingQuestionIds;
  const sid = started.session.id;
  store.record(sid, a, store.checkAnswerable(sid, a), noAnswerEvaluation("timeout"));
  store.record(sid, b, store.checkAnswerable(sid, b), { ...evaluation(true), model: null, rubricVersion: null, naturalAnswerEn: undefined, correctedAnswerEn: "I'm fine.", meaningEquivalent: false, transcriptionModel: "gemini-3.5-transcribe" } as any);
  store.record(sid, c, store.checkAnswerable(sid, c), evaluation(true));
  const items = store.finish(sid, "stopped").items.filter((item) => item.attempt);
  const noAnswer: any = items.find((item) => item.question.id === a).attempt;
  assert.equal(noAnswer.outcome, "no_answer");
  assert.equal(noAnswer.correctedAnswerEn, ""); // 空の文字のまま
  assert.equal(noAnswer.model, null);
  assert.equal(noAnswer.rubricVersion, "instant-v3");
  for (const key of ["meaningEquivalent", "naturalAnswerEn", "transcriptionModel"]) assert.equal(key in noAnswer, false, key);
  const full: any = items.find((item) => item.question.id === b).attempt;
  assert.equal(full.meaningEquivalent, false); // false は項目として出る
  assert.equal(full.transcriptionModel, "gemini-3.5-transcribe");
  assert.equal(full.correctedAnswerEn, "I'm fine.");
  assert.equal(full.model, null);
  assert.equal("outcome" in full, false);
  assert.equal("naturalAnswerEn" in full, false);
  const plain: any = items.find((item) => item.question.id === c).attempt;
  assert.equal(plain.naturalAnswerEn, "I'm doing well, thanks.");
  assert.equal(plain.passed, true);
  assert.equal(plain.model, "test");
  assert.equal("correctedAnswerEn" in plain, false);
});

test("alice・bob・1人用（''）の記録が混ざらない（同じ db に store を3つ）", async () => {
  const db = migratedDb(NOW);
  const make = (userKey: string) => createInstantStore({ db, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob"), solo = make("");
  const a = alice.start(undefined, { questionCount: 10 });
  assert.equal(bob.status().activeSession, null);
  assert.equal(solo.status().activeSession, null);
  const sessionId = a.session.id;
  const questionId = a.session.pendingQuestionIds[0];
  // alice の出題を bob と1人用は操作できない
  assert.equal(bob.checkAnswerable(sessionId, questionId), null);
  assert.equal(solo.checkAnswerable(sessionId, questionId), null);
  const aliceMeta = alice.checkAnswerable(sessionId, questionId);
  assert.ok(aliceMeta);
  assert.equal(bob.record(sessionId, questionId, aliceMeta, evaluation(true)), null);
  assert.equal(bob.finish(sessionId, "stopped"), null);
  assert.equal(bob.results(sessionId), null);
  const recorded = alice.record(sessionId, questionId, aliceMeta, evaluation(true));
  assert.ok(recorded);
  alice.finish(sessionId, "stopped");
  assert.equal(alice.history().progress.flatMap((p) => p.attempts).length, 1);
  assert.equal(bob.history().progress.flatMap((p) => p.attempts).length, 0);
  assert.equal(solo.history().progress.flatMap((p) => p.attempts).length, 0);
  // 読み上げ：alice の回答も、alice の終わった回にだけある問題の模範文も bob・1人用からは見えない
  const attemptId = recorded.attempt.id;
  assert.ok(alice.speechText(questionId, attemptId, false));
  assert.equal(bob.speechText(questionId, attemptId, false), null);
  assert.equal(solo.speechText(questionId, attemptId, false), null);
  assert.ok(alice.speechText(questionId, undefined, false));
  assert.equal(bob.speechText(questionId, undefined, false), null);
  assert.equal(solo.speechText(questionId, undefined, false), null);
  // alice が回を終えた後でも、bob と 1人用は答え合わせを取れない
  assert.ok(alice.results(sessionId));
  assert.equal(bob.results(sessionId), null);
  assert.equal(solo.results(sessionId), null);
  assert.equal(bob.finish(sessionId, "stopped"), null);
  // bob にも自分の進捗と世代がある
  const bobGeneration = bob.status().generationId;
  const b = bob.start(undefined, { questionCount: 10 });
  bob.record(b.session.id, b.session.pendingQuestionIds[0], bob.checkAnswerable(b.session.id, b.session.pendingQuestionIds[0]), evaluation(true));
  const soloGeneration = solo.status().generationId;
  assert.notEqual(alice.status().generationId, bobGeneration);
  assert.equal(alice.status().attempts, 1);
  assert.equal(bob.status().attempts, 1);
  assert.equal(solo.status().attempts, 0);
  // alice のリセットは bob と 1人用に影響しない
  alice.reset();
  assert.equal(alice.status().attempts, 0);
  assert.equal(bob.status().attempts, 1);
  assert.equal(bob.status().generationId, bobGeneration);
  assert.equal(bob.status().activeSession?.id, b.session.id);
  assert.equal(solo.status().generationId, soloGeneration);
  assert.equal(solo.status().attempts, 0);
  assert.equal(Number(db.all("SELECT COUNT(*) AS n FROM instant_progress WHERE user_key = ''")[0]?.n), 0);
  assert.equal(Number(db.all("SELECT COUNT(*) AS n FROM instant_progress WHERE user_key = 'bob'")[0]?.n), 1);
  // exportState も人ごと
  assert.equal(exportState(db, "bob").attempts.length, 1);
  assert.equal(exportState(db, "alice").attempts.length, 0);
  assert.equal(exportState(db).attempts.length, 0);
});

test("start の maxCount は問題数を上限で切る", () => {
  const { store } = fixture();
  assert.equal(store.start(undefined, { questionCount: 20, maxCount: 7 }).session.total, 7);
});

test("alice が問題をクリアしても、bob と 1人用の進捗は 0 のまま", () => {
  const db = migratedDb(NOW);
  const make = (userKey: string) => createInstantStore({ db, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob"), solo = make("");
  const ids = instantQuestions.slice(0, 3).map((q) => q.id);
  importState(db, { schemaVersion: 1, generationId: "gen-1", sessions: [{ id: "s-a", generationId: "gen-1", questionIds: ids, index: 0, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: null }], attempts: [], progress: { q001: { consecutivePasses: 2, clearedAt: null } } }, NOW, "alice");
  const done = alice.record("s-a", "q001", alice.checkAnswerable("s-a", "q001"), evaluation(true));
  assert.equal(done.attempt.consecutivePasses, 3);
  assert.equal(alice.status().cleared, 1);
  for (const other of [bob, solo]) {
    assert.equal(other.status().cleared, 0);
    assert.equal(other.history().progress.find((p) => p.question.id === "q001").consecutivePasses, 0);
  }
  assert.equal(alice.history().progress.find((p) => p.question.id === "q001").consecutivePasses, 3);
});

test("同じ世代 ID でも、bob は alice の出題を操作できない（世代 ID ではなく user_key で守る）", () => {
  const db = migratedDb(NOW);
  const make = (userKey: string) => createInstantStore({ db, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob");
  const ids = instantQuestions.slice(0, 3).map((q) => q.id);
  const state = (sessions: unknown[]) => ({ schemaVersion: 1, generationId: "gen-same", sessions, attempts: [], progress: {} });
  importState(db, state([{ id: "s-a", generationId: "gen-same", questionIds: ids, index: 0, startedAt: "2026-10-19T00:00:00.000Z", finishedAt: null }]), NOW, "alice");
  importState(db, state([]), NOW, "bob");
  assert.equal(alice.status().generationId, bob.status().generationId);
  assert.equal(bob.checkAnswerable("s-a", "q001"), null);
  assert.equal(bob.record("s-a", "q001", { generationId: "gen-same" }, evaluation(true)), null);
  assert.equal(bob.finish("s-a", "stopped"), null);
  assert.equal(bob.results("s-a"), null);
  assert.ok(alice.checkAnswerable("s-a", "q001"));
  assert.equal(db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0].n, 0);
});

test("start の maxCount は 1 以上の整数だけ（0・負・小数・NaN は誤りとして例外）", () => {
  const { store } = fixture();
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) assert.throws(() => store.start(undefined, { questionCount: 10, maxCount: bad }), /maxCount/, String(bad));
  assert.equal(store.start(undefined, { questionCount: 10, maxCount: 1 }).session.total, 1);
});

test("session_id で回答を引く問い合わせは、instant_attempts_user 索引を使わない（1人用で全件を読まない）", () => {
  const db = migratedDb(NOW);
  const src = readFileSync(new URL("../src/server/instant/store.ts", import.meta.url), "utf8");
  const queries = [...src.matchAll(/"((?:SELECT|UPDATE|DELETE)[^"]*FROM instant_attempts WHERE session_id = \?(?! AND question_id)[^"]*)"/g)].map((m) => m[1]);
  assert.equal(queries.length, 3);
  for (const q of queries) {
    const params = Array((q.match(/\?/g) ?? []).length).fill("x");
    const plan = db.all(`EXPLAIN QUERY PLAN ${q}`, ...params).map((r) => String(r.detail)).join(" | ");
    assert.ok(!plan.includes("instant_attempts_user"), `${q} → ${plan}`);
    assert.match(plan, /session_id=\?/, plan);
  }
});

test("todayAttempts：日本時間の今日に記録された回答の数（回答なしも数え、14:59:59.999Z と 15:00:00.000Z で分かれる）", () => {
  const db = migratedDb(NOW);
  const clock = { t: Date.UTC(2026, 9, 21, 14, 59, 59, 999) };
  const make = (userKey: string) => createInstantStore({ db, now: () => clock.t, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob"), solo = make("");
  const s = alice.start(undefined, { questionCount: 10 }).session;
  alice.record(s.id, s.pendingQuestionIds[0], alice.checkAnswerable(s.id, s.pendingQuestionIds[0]), evaluation(true));
  alice.record(s.id, s.pendingQuestionIds[1], alice.checkAnswerable(s.id, s.pendingQuestionIds[1]), noAnswerEvaluation("timeout"));
  assert.equal(alice.status().todayAttempts, 2);
  assert.equal(bob.status().todayAttempts, 0);
  assert.equal(solo.status().todayAttempts, 0);
  clock.t = Date.UTC(2026, 9, 21, 15, 0, 0, 0);
  assert.equal(alice.status().todayAttempts, 0);
  alice.record(s.id, s.pendingQuestionIds[2], alice.checkAnswerable(s.id, s.pendingQuestionIds[2]), evaluation(false));
  assert.equal(alice.status().todayAttempts, 1);
  assert.equal(alice.status().attempts, 3);
  clock.t = Date.UTC(2026, 9, 22, 14, 59, 59, 999);
  assert.equal(alice.status().todayAttempts, 1);
  clock.t = Date.UTC(2026, 9, 22, 15, 0, 0, 0);
  assert.equal(alice.status().todayAttempts, 0);
  // 1人用（''）にも付く。reset で今日の数は 0 に戻る
  clock.t = Date.UTC(2026, 9, 22, 3, 0, 0);
  const s2 = solo.start(undefined, { questionCount: 10 }).session;
  solo.record(s2.id, s2.pendingQuestionIds[0], solo.checkAnswerable(s2.id, s2.pendingQuestionIds[0]), evaluation(true));
  assert.equal(solo.status().todayAttempts, 1);
  assert.equal(solo.reset().todayAttempts, 0);
  assert.equal(db.all("SELECT COUNT(*) AS n FROM trial_daily WHERE user_key = ''")[0]?.n, 0);
});

test("todayAttempts の問い合わせは instant_attempts_user_created の範囲検索（全件を読まない）", () => {
  const db = migratedDb(NOW);
  const src = readFileSync(new URL("../src/server/instant/store.ts", import.meta.url), "utf8");
  const found = /"(SELECT COUNT\(\*\) AS n, COALESCE\(SUM\(score\), 0\) AS total FROM instant_attempts WHERE user_key = \? AND created_at >= \? AND created_at < \?)"/.exec(src);
  assert.ok(found, "todayAttempts の SQL が見つからない");
  const plan = db.all(`EXPLAIN QUERY PLAN ${found[1]}`, "", "a", "b").map((r) => String(r.detail)).join(" | ");
  assert.match(plan, /USING COVERING INDEX instant_attempts_user_created \(user_key=\? AND created_at>\? AND created_at<\?\)/, plan);
  // created_at は ISO のミリ秒つき（固定の長さ）なので、文字のまま比べられる
  const store = createInstantStore({ db, now: () => Date.UTC(2026, 0, 2, 3, 4, 5, 6), newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" });
  const s = store.start().session;
  store.record(s.id, s.pendingQuestionIds[0], store.checkAnswerable(s.id, s.pendingQuestionIds[0]), evaluation(true));
  assert.equal(db.all("SELECT created_at FROM instant_attempts")[0]?.created_at, "2026-01-02T03:04:05.006Z");
});

// ---- 平均点 ----
const attemptScores = (db: ReturnType<typeof migratedDb>, userKey: string) => Number(db.all("SELECT COALESCE(SUM(score), 0) AS t FROM instant_attempts WHERE user_key = ?", userKey)[0]?.t);
const metaTotal = (db: ReturnType<typeof migratedDb>, userKey: string) => Number(db.all("SELECT score_total FROM instant_meta WHERE user_key = ?", userKey)[0]?.score_total ?? 0);

test("今日の平均と全体の平均：回答なしは0点で数え、小数第1位で四捨五入、1件も無ければ null、0時で今日が切り替わる", () => {
  const db = migratedDb(NOW);
  const clock = { t: Date.UTC(2026, 9, 21, 14, 0, 0) }; // 日本時間 10/21 23:00
  const store = createInstantStore({ db, now: () => clock.t, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" });
  const empty = store.status();
  assert.equal(empty.todayAverage, null);
  assert.equal(empty.averageScore, null);
  const ids = instantQuestions.slice(0, 10).map((q) => q.id);
  importState(db, { schemaVersion: 1, generationId: "gen-1", sessions: [{ id: "s-1", generationId: "gen-1", questionIds: ids, index: 0, startedAt: "2026-10-21T13:00:00.000Z", finishedAt: null }], attempts: [{ id: "a-old", sessionId: "s-0", questionId: "q099", createdAt: "2026-10-20T03:00:00.000Z", ...evaluation(true), score: 70, consecutivePasses: 1 }], progress: {} }, NOW);
  const before = store.status();
  assert.equal(before.todayAverage, null);
  assert.equal(before.averageScore, 70);
  const rec = (i: number, score: number | "none") => store.record("s-1", ids[i], store.checkAnswerable("s-1", ids[i]), score === "none" ? noAnswerEvaluation("timeout") : { ...evaluation(true), score });
  assert.equal(rec(0, 96).summary.todayAverage, 96);
  const second = rec(1, "none").summary;
  assert.equal(second.todayAverage, 48);   // (96 + 0) / 2
  assert.equal(second.averageScore, 55.3); // (70 + 96 + 0) / 3 = 55.33…
  assert.equal(second.attempts, 3);
  clock.t = Date.UTC(2026, 9, 21, 15, 0, 0, 0); // 日本時間 10/22 0:00
  const next = store.status();
  assert.equal(next.todayAverage, null);
  assert.equal(next.todayAttempts, 0);
  assert.equal(next.averageScore, 55.3);
  clock.t = Date.UTC(2026, 9, 21, 14, 59, 59, 999);
  assert.equal(store.status().todayAverage, 48);
  // 四捨五入：(100 + 0 + 0) / 3 = 33.33… → 33.3、(100 + 100 + 0) / 3 = 66.66… → 66.7
  const db2 = migratedDb(NOW);
  const s2 = createInstantStore({ db: db2, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" });
  const q = s2.start(undefined, { questionCount: 10 }).session;
  const put = (i: number, score: number) => s2.record(q.id, q.pendingQuestionIds[i], s2.checkAnswerable(q.id, q.pendingQuestionIds[i]), { ...evaluation(true), score }).summary;
  assert.equal(put(0, 100).averageScore, 100);
  assert.equal(put(1, 0).averageScore, 50);
  assert.equal(put(2, 0).averageScore, 33.3);
  assert.equal(s2.status().todayAverage, 33.3);
});

test("平均は人ごと（alice・bob・1人用が混ざらない）。リセットで null に戻り、ほかの人は変わらない", () => {
  const db = migratedDb(NOW);
  const make = (userKey: string) => createInstantStore({ db, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob"), solo = make("");
  const give = (store: ReturnType<typeof make>, scores: number[]) => {
    const s = store.start(undefined, { questionCount: 10 }).session;
    scores.forEach((score, i) => store.record(s.id, s.pendingQuestionIds[i], store.checkAnswerable(s.id, s.pendingQuestionIds[i]), { ...evaluation(true), score }));
  };
  give(alice, [100, 80]); give(bob, [10]); give(solo, [50, 51]);
  assert.deepEqual([alice.status().averageScore, alice.status().todayAverage], [90, 90]);
  assert.deepEqual([bob.status().averageScore, bob.status().todayAverage], [10, 10]);
  assert.deepEqual([solo.status().averageScore, solo.status().todayAverage], [50.5, 50.5]);
  alice.reset();
  assert.deepEqual([alice.status().averageScore, alice.status().todayAverage], [null, null]);
  assert.equal(bob.status().averageScore, 10);
  assert.equal(solo.status().averageScore, 50.5);
  assert.equal(metaTotal(db, "alice"), 0);
});

test("合計の列（score_total）は、いつもその人の SUM(score) と同じ（記録・失敗の巻き戻し・リセット・取り込みの後も）", () => {
  const db = migratedDb(NOW);
  const make = (userKey: string, target: Parameters<typeof createInstantStore>[0]["db"] = db) => createInstantStore({ db: target, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey });
  const alice = make("alice"), bob = make("bob");
  const check = () => { for (const key of ["alice", "bob"]) assert.equal(metaTotal(db, key), attemptScores(db, key), key); };
  const s = alice.start(undefined, { questionCount: 10 }).session;
  const rec = (i: number, score: number) => alice.record(s.id, s.pendingQuestionIds[i], alice.checkAnswerable(s.id, s.pendingQuestionIds[i]), { ...evaluation(true), score });
  rec(0, 77); check();
  alice.record(s.id, s.pendingQuestionIds[1], alice.checkAnswerable(s.id, s.pendingQuestionIds[1]), noAnswerEvaluation("next")); check();
  // 2回目の書き込みで落ちる Db：進捗だけ書かれた状態も巻き戻り、合計も件数も変わらない
  let writes = 0;
  const failing = { all: (q: string, ...p: any[]) => db.all(q, ...p), run: (q: string, ...p: any[]) => { writes += 1; if (writes === 3) throw new Error("disk full"); db.run(q, ...p); }, transaction: <T,>(fn: () => T) => db.transaction(fn) };
  const broken = make("alice", failing as never);
  const before = alice.status();
  assert.throws(() => broken.record(s.id, s.pendingQuestionIds[2], broken.checkAnswerable(s.id, s.pendingQuestionIds[2]), { ...evaluation(true), score: 90 }), /disk full/);
  assert.equal(alice.status().attempts, before.attempts);
  assert.equal(alice.status().averageScore, before.averageScore);
  check();
  rec(2, 90); check();
  const b = bob.start(undefined, { questionCount: 10 }).session;
  bob.record(b.id, b.pendingQuestionIds[0], bob.checkAnswerable(b.id, b.pendingQuestionIds[0]), { ...evaluation(false), score: 28 }); check();
  alice.reset(); check();
  assert.equal(metaTotal(db, "alice"), 0);
  // 取り込み（importState）は、入れた回答の合計で作り直す
  importState(db, { schemaVersion: 1, generationId: "gen-9", sessions: [], attempts: [{ id: "x1", sessionId: "s", questionId: "q001", createdAt: "2026-10-20T00:00:00.000Z", ...evaluation(true), score: 61, consecutivePasses: 1 }, { id: "x2", sessionId: "s", questionId: "q002", createdAt: "2026-10-20T00:00:00.000Z", ...evaluation(false), score: 40, consecutivePasses: 0 }], progress: {} }, NOW, "alice");
  check();
  assert.equal(alice.status().averageScore, 50.5);
});
