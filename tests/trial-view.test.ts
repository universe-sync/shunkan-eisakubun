import assert from "node:assert/strict";
import { test } from "node:test";
import { TRIAL_CLOSED_TEXT, TRIAL_DAILY_DONE_TEXT, endsOnLabel, msUntilJstMidnight, parseTrialInfo, trialBarText, trialBlockedMessage, trialNextCount, trialRemaining, trialSpeechRemaining, type TrialInfo } from "../src/client/lib/trial-view";

const base: TrialInfo = { name: "Mika", questionsUsed: 0, questionsLimit: 30, speechUsed: 0, speechLimit: 5, endsOn: null, closed: false, dailyDone: false };
const with_ = (o: Partial<TrialInfo>): TrialInfo => ({ ...base, ...o });

test("parseTrialInfo：正しい形は通し、壊れた形・足りない項目は null", () => {
  assert.deepEqual(parseTrialInfo(base), base);
  assert.deepEqual(parseTrialInfo({ ...base, endsOn: "2026-10-21" })?.endsOn, "2026-10-21");
  for (const bad of [null, undefined, "x", 1, [], {}, { ...base, name: 5 }, { ...base, questionsUsed: -1 }, { ...base, questionsUsed: 1.5 }, { ...base, closed: "no" }, { ...base, endsOn: "10/21" }, { ...base, speechLimit: undefined }]) {
    assert.equal(parseTrialInfo(bad), null, JSON.stringify(bad));
  }
});

test("残りの数と、出題の問題数（1回10問・今日の残り・未クリアの小さい方）", () => {
  assert.equal(trialRemaining(with_({ questionsUsed: 23 })), 7);
  assert.equal(trialRemaining(with_({ questionsUsed: 40 })), 0);
  assert.equal(trialSpeechRemaining(with_({ speechUsed: 2 })), 3);
  assert.equal(trialNextCount(base, 100), 10);
  assert.equal(trialNextCount(with_({ questionsUsed: 23 }), 100), 7);
  assert.equal(trialNextCount(with_({ questionsUsed: 23 }), 3), 3);
  assert.equal(trialNextCount(with_({ questionsUsed: 30 }), 100), 0);
});

test("止める文言は、終了日の後を先に、その次に今日の分", () => {
  assert.equal(trialBlockedMessage(base), null);
  assert.equal(trialBlockedMessage(with_({ dailyDone: true, questionsUsed: 30 })), TRIAL_DAILY_DONE_TEXT);
  assert.equal(trialBlockedMessage(with_({ closed: true, dailyDone: true })), TRIAL_CLOSED_TEXT);
  assert.equal(trialBlockedMessage(with_({ questionsUsed: 30 })), TRIAL_DAILY_DONE_TEXT); // dailyDone が遅れて届いても、残り0なら止める
});

test("msUntilJstMidnight：日本時間の0時（UTC 15:00）まで", () => {
  assert.equal(msUntilJstMidnight(Date.UTC(2026, 9, 21, 14, 59, 59)), 1000);
  assert.equal(msUntilJstMidnight(Date.UTC(2026, 9, 21, 15, 0, 0)), 86_400_000);
  assert.equal(msUntilJstMidnight(Date.UTC(2026, 9, 21, 3, 0, 0)), 12 * 3_600_000);
});

test("帯の文", () => {
  assert.equal(trialBarText(with_({ questionsUsed: 5, speechUsed: 1, endsOn: "2026-10-21" })), "Mikaさん・今日の残り 25問・読み上げ残り 4回・10月21日まで");
  assert.equal(trialBarText(base), "Mikaさん・今日の残り 30問・読み上げ残り 5回");
  assert.match(trialBarText(with_({ dailyDone: true })), /今日のお試しは終了しました/);
  assert.equal(trialBarText(with_({ closed: true })), "お試し期間は終わりました");
  assert.equal(endsOnLabel("2026-01-05"), "1月5日");
});
