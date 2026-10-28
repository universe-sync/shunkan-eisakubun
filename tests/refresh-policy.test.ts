import assert from "node:assert/strict";
import { test } from "node:test";
import { idleMessage, refreshApplies, sessionProgressed, shouldRefresh } from "../src/client/lib/refresh-policy";
import { type TrialInfo } from "../src/client/lib/trial-view";

const trial: TrialInfo = { name: "Mika", questionsUsed: 0, questionsLimit: 100, speechUsed: 0, speechLimit: 10, endsOn: null, closed: false, dailyDone: false };
const none = { activeSession: null };
const pending = (n: number) => ({ activeSession: { pendingQuestionIds: Array.from({ length: n }, (_, i) => `q${i}`) } });

test("idleMessage：途中の出題あり／お試し／1人用／止まっている", () => {
  assert.match(idleMessage(pending(4), null), /前回の出題が途中です。.*まだ答えていない4問から続けます/);
  assert.match(idleMessage(pending(4), trial), /前回の出題が途中です/);
  assert.match(idleMessage(none, trial), /お試しは1回10問です/);
  assert.match(idleMessage(none, null), /1問の時間と問題数は/);
  assert.match(idleMessage(none, { ...trial, dailyDone: true }), /今日のお試しは終了しました/);
  assert.match(idleMessage(pending(4), { ...trial, questionsUsed: 100 }), /今日のお試しは終了しました/); // 止まっている理由が先
  assert.match(idleMessage(none, { ...trial, closed: true }), /お試し期間は終わりました/);
});

const q = (id: string) => ({ id, japanese: "日本語", category: "x" });
const run = (o: Partial<Parameters<typeof sessionProgressed>[0]> = {}) => ({ phase: "paused" as const, sessionId: "s1", questions: [q("a"), q("b")], position: 0, ...o });

test("sessionProgressed：出題が無い・id 違い・今の問題が未回答に無いときは真、同じなら偽", () => {
  assert.equal(sessionProgressed(run(), null), true);
  assert.equal(sessionProgressed(run(), { id: "s2", pendingQuestionIds: ["a", "b"] }), true);
  assert.equal(sessionProgressed(run(), { id: "s1", pendingQuestionIds: ["b"] }), true);
  assert.equal(sessionProgressed(run(), { id: "s1", pendingQuestionIds: ["a", "b"] }), false);
  assert.equal(sessionProgressed(run({ position: 1 }), { id: "s1", pendingQuestionIds: ["b"] }), false);
  assert.equal(sessionProgressed(run({ position: 5 }), { id: "s1", pendingQuestionIds: ["b"] }), true);
  assert.equal(sessionProgressed(run({ phase: "idle" }), null), false); // 出題中でなければ判断しない
});

test("shouldRefresh：まだ読んでいなければ真、minMs 未満は偽、以上は真", () => {
  assert.equal(shouldRefresh(null, 1000, 15_000), true);
  assert.equal(shouldRefresh(1000, 15_999, 15_000), false);
  assert.equal(shouldRefresh(1000, 16_000, 15_000), true);
  assert.equal(shouldRefresh(0, 59_999, 60_000), false);
  assert.equal(shouldRefresh(0, 60_000, 60_000), true);
});

test("refreshApplies：文の番号が進んでいたら文を置き直さない。run・reset が変わっていたら何も触らない。保存が始まっていたら設定を適用しない", () => {
  const m = { message: 3, run: 1, reset: 0, save: 2 };
  assert.deepEqual(refreshApplies(m, { ...m }, { saving: false }), { summary: true, message: true, settings: true });
  assert.deepEqual(refreshApplies(m, { ...m, message: 4 }, { saving: false }), { summary: true, message: false, settings: true });
  assert.deepEqual(refreshApplies(m, { ...m, run: 2 }, { saving: false }), { summary: false, message: false, settings: false });
  assert.deepEqual(refreshApplies(m, { ...m, reset: 1 }, { saving: false }), { summary: false, message: false, settings: false });
  assert.deepEqual(refreshApplies(m, { ...m, save: 3 }, { saving: false }), { summary: true, message: true, settings: false });
  assert.deepEqual(refreshApplies(m, { ...m }, { saving: true }), { summary: true, message: true, settings: false });
});
