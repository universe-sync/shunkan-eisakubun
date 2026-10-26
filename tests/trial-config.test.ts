import assert from "node:assert/strict";
import { test } from "node:test";
import { TRIAL_DEFAULTS, resetTrialWarnings, trialClosed, trialConfig, trialEnabled } from "../src/server/trial/config";

function warnings<T>(work: () => T): { value: T; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const original = console.warn; console.warn = (...a) => warns.push(a);
  try { return { value: work(), warns }; } finally { console.warn = original; }
}

test("TRIAL_MODE は \"1\" だけ有効", () => {
  assert.equal(trialEnabled({ TRIAL_MODE: "1" }), true);
  for (const v of [undefined, "", "0", "true", " 1", "01"]) assert.equal(trialEnabled({ TRIAL_MODE: v as string }), false, String(v));
});

test("既定は 30問・5回、不正は既定に戻して警告は1回だけ", () => {
  resetTrialWarnings();
  assert.equal(TRIAL_DEFAULTS.questionsPerDay, 30);
  assert.equal(TRIAL_DEFAULTS.speechPerDay, 5);
  const ok = trialConfig({});
  assert.deepEqual([ok.questionsPerDay, ok.speechPerDay, ok.endsOn, ok.enabled], [30, 5, null, false]);
  const { value, warns } = warnings(() => { trialConfig({ TRIAL_QUESTIONS_PER_DAY: "abc", TRIAL_SPEECH_PER_DAY: "0" }); return trialConfig({ TRIAL_QUESTIONS_PER_DAY: "abc", TRIAL_SPEECH_PER_DAY: "501" }); });
  assert.deepEqual([value.questionsPerDay, value.speechPerDay], [30, 5]);
  assert.equal(warns.length, 2); // 2つの項目で1回ずつ
  assert.deepEqual([trialConfig({ TRIAL_QUESTIONS_PER_DAY: "12", TRIAL_SPEECH_PER_DAY: "3" }).questionsPerDay, trialConfig({ TRIAL_SPEECH_PER_DAY: "3" }).speechPerDay], [12, 3]);
});

test("TRIAL_ENDS_ON は正しい日付だけ。不正は null（終わらない）", () => {
  resetTrialWarnings();
  assert.equal(trialConfig({ TRIAL_ENDS_ON: "2026-10-21" }).endsOn, "2026-10-21");
  const { warns } = warnings(() => { for (const bad of ["2026-02-30", "2026-1-1", "abc", "2026-13-01"]) assert.equal(trialConfig({ TRIAL_ENDS_ON: bad }).endsOn, null, bad); });
  assert.equal(warns.length, 1);
});

test("trialClosed：終了日を含み、日本時間の翌日0時（UTC 15:00）から閉じる", () => {
  const cfg = trialConfig({ TRIAL_MODE: "1", TRIAL_ENDS_ON: "2026-10-21" });
  assert.equal(trialClosed(cfg, Date.UTC(2026, 9, 21, 14, 59, 59, 999)), false);
  assert.equal(trialClosed(cfg, Date.UTC(2026, 9, 21, 15, 0, 0)), true);
  assert.equal(trialClosed(trialConfig({ TRIAL_MODE: "1" }), Date.UTC(2030, 0, 1)), false);
});
