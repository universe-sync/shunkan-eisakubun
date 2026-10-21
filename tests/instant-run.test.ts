import { forbidNetwork } from "./helpers/no-network";
forbidNetwork();
// 瞬間英作文の自動進行の純粋な論理（src/instant-run.js）の試験
import test from "node:test";
import assert from "node:assert/strict";
import { canSkip, correctionToShow, countResults, currentQuestion, elapsedWholeSeconds, initialRun, isMeaningOkBelowPass, isSettled, isTimeUp, limitMs, mergeResults, nextKeyAction, normalizeEnglish, pauseCountdown, pendingCount, remainingMs, remainingWholeSeconds, resumeCountdown, runReducer, startCountdown } from "../src/client/lib/instant-run.js";

const questions = [{ id: "q1", japanese: "一", category: "a" }, { id: "q2", japanese: "二", category: "a" }, { id: "q3", japanese: "三", category: "a" }];
const run = (state, ...events) => events.reduce((current, event) => runReducer(current, event), state);
const running = () => run(initialRun(), { type: "request_mic" }, { type: "begin", sessionId: "s", questions, now: 0 });
const recorded = (id) => ({ kind: "recorded", attempt: { id: `a-${id}`, questionId: id, outcome: "answered", transcript: "x", score: 90, passed: true, consecutivePasses: 1 } });

test("残り時間は経過時刻で計算し、一時停止の間は進まない", () => {
  const c = startCountdown(1000);
  assert.equal(remainingMs(c, 1000), 10000);
  assert.equal(remainingMs(c, 4000), 7000);
  const paused = pauseCountdown(c, 4000);
  assert.equal(remainingMs(paused, 9000), 7000);
  assert.equal(pauseCountdown(paused, 9000), paused); // 同じものが返る
  const resumed = resumeCountdown(paused, 9000);
  assert.equal(remainingMs(resumed, 12000), 4000);
  assert.equal(remainingMs(resumed, 16000), 0);
  assert.equal(remainingMs(resumed, 99999), 0); // 負にならない
  assert.equal(resumeCountdown(c, 5000), c); // 止まっていないときの再開
});

test("秒の表示は切り上げ", () => {
  const c = startCountdown(0);
  assert.deepEqual([0, 1, 1000, 9999, 10000].map((t) => remainingWholeSeconds(c, t)), [10, 10, 9, 1, 0]);
});

test("3問の流れ：開始 → 次へ → 最後で採点待ち → 結果がそろって完了", () => {
  let state = initialRun();
  assert.equal(runReducer(state, { type: "begin", sessionId: "s", questions, now: 0 }), state); // mic 以外では無視
  state = run(state, { type: "request_mic" });
  assert.equal(state.phase, "mic");
  state = run(state, { type: "begin", sessionId: "s", questions, now: 0 });
  assert.equal(state.phase, "running");
  const paused = run(state, { type: "pause", now: 3000 });
  assert.equal(paused.phase, "paused");
  assert.equal(runReducer(paused, { type: "advance", now: 5000 }), paused); // 一時停止中の advance は無視
  state = run(paused, { type: "resume", now: 5000 });
  assert.equal(state.phase, "running");
  state = run(state, { type: "advance", now: 12000 });
  assert.equal(state.position, 1);
  assert.deepEqual(state.outcomes, { q1: { kind: "pending" } });
  assert.equal(state.countdown.startedAt, 12000);
  state = run(state, { type: "advance", now: 22000 });
  assert.equal(state.position, 2);
  state = run(state, { type: "advance", now: 32000 });
  assert.equal(state.phase, "finishing");
  assert.equal(state.stopReason, "completed");
  assert.equal(pendingCount(state), 3);
  assert.equal(isSettled(state), false);
  state = run(state, { type: "outcome", questionId: "q1", outcome: recorded("q1") });
  assert.equal(pendingCount(state), 2);
  const same = runReducer(state, { type: "outcome", questionId: "q1", outcome: { kind: "skipped" } }); // 2回目は捨てる
  assert.equal(same, state);
  assert.equal(runReducer(state, { type: "outcome", questionId: "zz", outcome: { kind: "skipped" } }), state); // 知らない問題
  state = run(state, { type: "outcome", questionId: "q2", outcome: recorded("q2") }, { type: "outcome", questionId: "q3", outcome: { kind: "unscored", message: "x" } });
  assert.equal(isSettled(state), true);
  state = run(state, { type: "done" });
  assert.equal(state.phase, "done");
  assert.equal(run(state, { type: "request_mic" }).phase, "mic"); // 次の10問
});

test("一時停止中の停止：今の問題だけが結果待ちになる", () => {
  const paused = run(running(), { type: "advance", now: 10000 }, { type: "pause", now: 12000 });
  const stopped = run(paused, { type: "stop", segmentSent: true });
  assert.equal(stopped.phase, "finishing");
  assert.equal(stopped.stopReason, "stopped");
  assert.deepEqual(Object.keys(stopped.outcomes).sort(), ["q1", "q2"]);
  assert.equal(pendingCount(stopped), 2);
  assert.equal(run(stopped, { type: "stop", segmentSent: true }), stopped);
  const unsent = run(running(), { type: "stop", segmentSent: false });
  assert.equal(isSettled(unsent), true);
});

test("give_up：結果待ちを未採点にして完了扱いにする", () => {
  let state = run(running(), { type: "advance", now: 10000 }, { type: "advance", now: 20000 }, { type: "advance", now: 30000 });
  state = run(state, { type: "outcome", questionId: "q1", outcome: recorded("q1") }, { type: "give_up" });
  assert.deepEqual(state.outcomes.q2, { kind: "unscored", message: "採点の結果を待たずに終了しました。" });
  assert.deepEqual(state.outcomes.q3, { kind: "unscored", message: "採点の結果を待たずに終了しました。" });
  assert.equal(state.outcomes.q1.kind, "recorded");
  assert.equal(isSettled(state), true);
  assert.equal(runReducer(running(), { type: "give_up" }).phase, "running"); // finishing 以外では無視
});

test("begin は問題が空だと無視され、running 中の request_mic も無視される。currentQuestion は running と paused だけ", () => {
  const mic = run(initialRun(), { type: "request_mic" });
  assert.equal(runReducer(mic, { type: "begin", sessionId: "s", questions: [], now: 0 }), mic);
  const state = running();
  assert.equal(runReducer(state, { type: "request_mic" }), state);
  assert.equal(currentQuestion(state).id, "q1");
  assert.equal(currentQuestion(run(state, { type: "pause", now: 1 })).id, "q1");
  assert.equal(currentQuestion(initialRun()), null);
  assert.equal(currentQuestion(run(state, { type: "stop", segmentSent: false })), null);
  assert.equal(run(state, { type: "abort" }).phase, "idle");
});

test("答え合わせの行と数：サーバーの記録を優先し、未採点だけ画面が足す", () => {
  const q = (id) => ({ id, japanese: id });
  const attempt = (fields) => ({ passed: true, score: 90, ...fields });
  const items = [
    { question: q("a"), attempt: attempt({ passed: true, score: 90 }) },
    { question: q("b"), attempt: attempt({ outcome: "no_answer", passed: false, score: 0 }) },
    { question: q("c"), attempt: null },
    { question: q("d"), attempt: null },
    { question: q("e"), attempt: null },
    { question: q("f"), attempt: attempt({ passed: false, score: 41 }) }
  ];
  const outcomes = { c: { kind: "unscored", message: "通信" }, d: { kind: "skipped" }, f: { kind: "unscored", message: "無視される" } };
  const rows = mergeResults(items, outcomes as any);
  assert.deepEqual(rows.map((row) => [row.question.id, row.status]), [["a", "answered"], ["b", "no_answer"], ["c", "unscored"], ["f", "answered"]]);
  assert.equal(rows[2].message, "通信");
  assert.deepEqual(countResults(rows), { shown: 4, recorded: 3, passed: 1, noAnswer: 1, unscored: 1, averageScore: 44 });
  assert.equal(countResults([]).averageScore, null);
});

test("nextKeyAction：実行中の Tab は0.5秒たってから skip、それまでと押しっぱなし・変換中は block", () => {
  const state = running(); // begin は now=0
  assert.equal(nextKeyAction(state, { key: "Tab" }, 600), "skip");
  assert.equal(nextKeyAction(state, { key: "Tab" }, 300), "block");
  assert.equal(nextKeyAction(state, { key: "Tab" }, 500), "skip"); // 境目は0.5秒ちょうどから
  assert.equal(nextKeyAction(state, { key: "Tab", repeat: true }, 600), "block");
  assert.equal(nextKeyAction(state, { key: "Tab", isComposing: true }, 600), "block");
  for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) assert.equal(nextKeyAction(state, { key: "Tab", [modifier]: true }, 600), "ignore", modifier);
  assert.equal(nextKeyAction(state, { key: "Enter" }, 600), "ignore");
  const paused = run(state, { type: "pause", now: 1000 });
  const finishing = run(state, { type: "stop", segmentSent: true });
  for (const other of [paused, initialRun(), finishing, run(finishing, { type: "done" })]) assert.equal(nextKeyAction(other, { key: "Tab" }, 5000), "ignore");
});

test("nextKeyAction・canSkip：経過時間から一時停止の時間を除く", () => {
  const state = run(running(), { type: "pause", now: 200 }, { type: "resume", now: 5000 });
  assert.equal(nextKeyAction(state, { key: "Tab" }, 5200), "block"); // 経過 400
  assert.equal(canSkip(state, 5200), false);
  assert.equal(nextKeyAction(state, { key: "Tab" }, 5400), "skip"); // 経過 600
  assert.equal(canSkip(state, 5400), true);
  assert.equal(canSkip(initialRun(), 9999), false);
});

test("mergeResults：未採点の行に書き起こしが入る（無ければ undefined）", () => {
  const items = [{ question: { id: "a" }, attempt: null }, { question: { id: "b" }, attempt: null }];
  const rows = mergeResults(items, { a: { kind: "unscored", message: "採点（Claude）でエラー", transcript: "I'm tired." }, b: { kind: "unscored", message: "聞き取り（Gemini）でエラー" } });
  assert.equal(rows[0].transcript, "I'm tired.");
  assert.equal(rows[1].transcript, undefined);
});

test("制限なし（durationMs が null）：60秒で時間切れと同じ、経過の秒を出し、一時停止の時間は数えない", () => {
  const c = startCountdown(1000, null);
  assert.equal(c.durationMs, null);
  assert.equal(limitMs(c), 60000);
  assert.equal(elapsedWholeSeconds(c, 13_999), 12);
  assert.equal(isTimeUp(c, 60_999), false);
  assert.equal(isTimeUp(c, 61_000), true);
  const resumed = resumeCountdown(pauseCountdown(c, 11_000), 41_000); // 30秒止めた
  assert.equal(isTimeUp(resumed, 90_999), false);
  assert.equal(isTimeUp(resumed, 91_000), true);
});

test("秒数指定（15・30秒）：残りの秒（切り上げ）と isTimeUp の境目", () => {
  for (const seconds of [15, 30]) {
    const c = startCountdown(0, seconds * 1000);
    assert.equal(remainingWholeSeconds(c, 0), seconds);
    assert.equal(remainingWholeSeconds(c, 1), seconds);
    assert.equal(remainingWholeSeconds(c, seconds * 1000 - 1), 1);
    assert.equal(isTimeUp(c, seconds * 1000 - 1), false);
    assert.equal(isTimeUp(c, seconds * 1000), true);
  }
});

test("reducer：begin の durationMs（null・15000・指定なし）は次の問題へ進んでも保たれる", () => {
  const begin = (durationMs) => run(initialRun(), { type: "request_mic" }, { type: "begin", sessionId: "s", questions, now: 0, ...(durationMs === undefined ? {} : { durationMs }) });
  for (const [given, expected] of [[null, null], [15000, 15000], [undefined, 10000]]) {
    const state = run(begin(given), { type: "advance", now: 5000 });
    assert.equal(state.countdown.durationMs, expected, String(given));
    assert.equal(run(state, { type: "advance", now: 9000 }).countdown?.durationMs ?? expected, expected);
  }
});

test("制限なしの Tab：0.5秒のガードと、押しっぱなし・変換中の block は同じ", () => {
  const state = run(initialRun(), { type: "request_mic" }, { type: "begin", sessionId: "s", questions, now: 0, durationMs: null });
  assert.equal(nextKeyAction(state, { key: "Tab" }, 300), "block");
  assert.equal(nextKeyAction(state, { key: "Tab" }, 500), "skip");
  assert.equal(canSkip(state, 59_000), true);
  assert.equal(nextKeyAction(state, { key: "Tab", repeat: true }, 600), "block");
  assert.equal(nextKeyAction(state, { key: "Tab", isComposing: true }, 600), "block");
});

test("isMeaningOkBelowPass：意味が伝わって不合格のときだけ true", () => {
  assert.equal(isMeaningOkBelowPass({ outcome: "answered", passed: false, meaningEquivalent: true }), true);
  assert.equal(isMeaningOkBelowPass({ passed: true, meaningEquivalent: true }), false);
  assert.equal(isMeaningOkBelowPass({ passed: false, meaningEquivalent: false }), false);
  assert.equal(isMeaningOkBelowPass({ passed: false }), false); // 古い記録（項目なし）
  assert.equal(isMeaningOkBelowPass({ outcome: "no_answer", passed: false, meaningEquivalent: true }), false);
});

test("normalizeEnglish：大文字小文字・句読点・空白・アポストロフィの種類は同じ、It's と Its は違う", () => {
  assert.equal(normalizeEnglish("I'm  tired!"), normalizeEnglish("i’m tired"));
  assert.notEqual(normalizeEnglish("It's"), normalizeEnglish("Its"));
  assert.equal(normalizeEnglish(null), "");
});

test("correctionToShow：回答と同じ・模範文と同じ・空・項目なし・回答なしは出さない", () => {
  const attempt = (extra) => ({ outcome: "answered", transcript: "I'm coughing since yesterday.", correctedAnswerEn: "I've been coughing since yesterday.", ...extra });
  const reference = "I've had a cough since yesterday.";
  assert.equal(correctionToShow(attempt({}), reference), "I've been coughing since yesterday.");
  assert.equal(correctionToShow(attempt({ correctedAnswerEn: "  i'm coughing since yesterday  " }), reference), null); // 回答と同じ
  assert.equal(correctionToShow(attempt({ correctedAnswerEn: "I’ve had a cough since yesterday!" }), reference), null); // 模範文と同じ
  assert.equal(correctionToShow(attempt({ correctedAnswerEn: " Fine, thanks. " }), reference), "Fine, thanks."); // trim
  assert.equal(correctionToShow(attempt({ correctedAnswerEn: "   " }), reference), null);
  assert.equal(correctionToShow(attempt({ correctedAnswerEn: undefined }), reference), null);
  assert.equal(correctionToShow(attempt({ outcome: "no_answer" }), reference), null);
  assert.equal(correctionToShow(attempt({}), undefined), "I've been coughing since yesterday.");
});
