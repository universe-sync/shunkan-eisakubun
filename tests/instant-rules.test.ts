import { forbidNetwork } from "./helpers/no-network";
forbidNetwork();
// 瞬間英作文の決まり（src/instant-rules.js）の試験
import test from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MAX_SECONDS, PASS_SCORE, QUESTION_COUNT_DEFAULT, QUESTION_COUNT_OPTIONS, QUESTION_SECONDS_DEFAULT, QUESTION_SECONDS_MAX, QUESTION_SECONDS_MIN, QUESTION_SECONDS_PRESETS, parseQuestionCount, parseQuestionSeconds, questionDurationMs, questionSecondsLabel, stepQuestionSeconds } from "../src/shared/instant-rules.js";

test("定数", () => {
  assert.equal(PASS_SCORE, 80);
  assert.deepEqual([QUESTION_SECONDS_MIN, QUESTION_SECONDS_MAX, QUESTION_SECONDS_DEFAULT], [10, 30, 10]);
  assert.deepEqual([...QUESTION_SECONDS_PRESETS], [10, 15, 20, 30]);
  assert.equal(ANSWER_MAX_SECONDS, 60);
  assert.deepEqual([...QUESTION_COUNT_OPTIONS], [10, 20, 30, 50]);
  assert.equal(QUESTION_COUNT_DEFAULT, 10);
});

test("parseQuestionSeconds：10〜30の整数だけ通す（\"none\"＝制限なしは通さない）", () => {
  for (const value of [10, 15, 30]) assert.equal(parseQuestionSeconds(value), value);
  for (const value of [9, 31, 15.5, "15", "none", "None", null, undefined, true, NaN, Infinity, [], {}]) assert.equal(parseQuestionSeconds(value), undefined, String(value));
});

test("parseQuestionCount：10・20・30・50だけ通す", () => {
  for (const value of [10, 20, 30, 50]) assert.equal(parseQuestionCount(value), value);
  for (const value of [15, 40, 0, 100, "10", 10.5, null, undefined]) assert.equal(parseQuestionCount(value), undefined, String(value));
});

test("stepQuestionSeconds・questionDurationMs・questionSecondsLabel", () => {
  assert.equal(stepQuestionSeconds(10, -1), 10);
  assert.equal(stepQuestionSeconds(10, 1), 11);
  assert.equal(stepQuestionSeconds(30, 1), 30);
  assert.equal(stepQuestionSeconds(29, 5), 30);
  assert.equal(stepQuestionSeconds(12, -5), 10);
  assert.equal(questionDurationMs(15), 15000);
  assert.equal(questionSecondsLabel(15), "15秒");
  assert.equal(questionSecondsLabel("none"), "制限なし"); // 前の版の記録の表示用
});
