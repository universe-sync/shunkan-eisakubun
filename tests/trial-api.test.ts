// お試しモードの DO 側（API）の試験：人ごとの記録・1日の上限・終了日・読み上げの上限・管理用の一覧。node:sqlite の上で、外部 API は偽
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeUserKey, USER_KEY_HEADER } from "../src/server/gate/user-token";
import { trialParticipantsReport } from "../src/server/trial/admin";
import { registerUser, trialToday } from "../src/server/trial/users";
import { forbidNetwork } from "./helpers/no-network";
import { makeApi, makeTrialApi, T0, type TrialApiUser } from "./helpers/api";
import { silence, speechLike, toBase64, toWav } from "./helpers/wav-fixtures";

forbidNetwork();

const voiced = () => toBase64(toWav(speechLike()));
const quiet = () => toBase64(toWav(silence(2.2)));
const GATE_REASON = "trial_name_required";
const DAY1 = "2026-10-21";

async function begin(u: TrialApiUser) {
  const st = (await u.getJson("/api/instant/status")).body;
  const r = await u.postJson("/api/instant/start", { generationId: st.generationId });
  return r;
}
/** n 問を回答なしで記録する（出題は 10 問ずつ。足りなければ次の出題を始める） */
async function noAnswers(u: TrialApiUser, n: number) {
  let done = 0;
  while (done < n) {
    const r = await begin(u);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const id of r.body.session.pendingQuestionIds as string[]) {
      if (done >= n) break;
      const rec = await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: id, segmentEnd: "timeout" });
      assert.equal(rec.status, 200, JSON.stringify(rec.body));
      done += 1;
    }
    await u.postJson("/api/instant/finish", { sessionId: r.body.session.id, reason: "stopped" }); // 途中の回は閉じて、次の start で新しい出題にする
  }
}
const setDaily = (a: ReturnType<typeof makeTrialApi>, key: string, day: string, answers: number, speech = 0) =>
  a.db.run("INSERT INTO trial_daily (user_key, day, answers, speech) VALUES (?, ?, ?, ?) ON CONFLICT (user_key, day) DO UPDATE SET answers = excluded.answers, speech = excluded.speech", key, day, answers, speech);

test("前段：ヘッダー無し・未登録・不正な base64url・大文字の鍵は 403 trial_name_required。/api/health は通る", async () => {
  const a = makeTrialApi();
  const cases: Array<Record<string, string>> = [{}, { [USER_KEY_HEADER]: encodeUserKey("ghost") }, { [USER_KEY_HEADER]: "***" }, { [USER_KEY_HEADER]: encodeUserKey("Alice") }];
  for (const headers of cases) {
    for (const path of ["/api/instant/status", "/api/usage", "/api/instant/settings"]) {
      const r = await a.getJson(path, headers);
      assert.equal(r.status, 403, path);
      assert.equal(r.body.reason, GATE_REASON);
    }
    const start = await a.postJson("/api/instant/start", {}, headers);
    assert.equal(start.status, 403);
    assert.equal(start.body.reason, GATE_REASON);
    const big = await a.postJson("/api/instant/answer", { audioBase64: "A".repeat(100_000) }, headers);
    assert.equal(big.status, 403);
  }
  assert.equal((await a.getJson("/api/health")).status, 200);
  assert.equal(a.db.all("SELECT * FROM instant_meta").length, 0); // どれも記録を作らない
});

test("status.trial は8項目ちょうどで、初めは 0/30・読み上げ 0/5・closed false・dailyDone false", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  const t = (await u.getJson("/api/instant/status")).body.trial;
  assert.deepEqual(Object.keys(t).sort(), ["closed", "dailyDone", "endsOn", "name", "questionsLimit", "questionsUsed", "speechLimit", "speechUsed"]);
  assert.deepEqual(t, { name: "Mika", questionsUsed: 0, questionsLimit: 30, speechUsed: 0, speechLimit: 5, endsOn: null, closed: false, dailyDone: false });
  assert.deepEqual((await u.getJson("/api/trial/me")).body, { trial: t });
});

test("1回は10問に固定（50を送っても10）。15は400", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  const st = (await u.getJson("/api/instant/status")).body;
  assert.equal((await u.postJson("/api/instant/start", { generationId: st.generationId, questionCount: 15 })).status, 400);
  const r = await u.postJson("/api/instant/start", { generationId: st.generationId, questionCount: 50 });
  assert.equal(r.body.session.total, 10);
  assert.ok(r.body.trial && typeof r.body.trial === "object", "お試しの start 応答に trial がある");
  assert.deepEqual(r.body.trial, (await u.getJson("/api/trial/me")).body.trial, "start の trial は /api/trial/me の trial と同じ");
});

test("別の端末で10問答えた後に start すると、start 応答の trial.questionsUsed に反映される", async () => {
  const a = makeTrialApi();
  const pc = a.as("Mika"); // サーバーは人の鍵で見るので、同じ鍵＝別の端末と同じ（スマホで10問、PC でスタート）
  await noAnswers(pc, 10);
  const r = await begin(pc);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trial.questionsUsed, 10);
  assert.deepEqual(r.body.trial, (await pc.getJson("/api/trial/me")).body.trial);
  assert.deepEqual(r.body.trial, (await pc.getJson("/api/instant/status")).body.trial);
});

test("29問→1問だけ出る→記録で30問になり、続く start は 429 trial_daily_done", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  await noAnswers(u, 29);
  const r = await begin(u);
  assert.equal(r.body.session.total, 1);
  await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: r.body.session.pendingQuestionIds[0], segmentEnd: "next" });
  const st = (await u.getJson("/api/instant/status")).body;
  assert.equal(st.trial.questionsUsed, 30);
  assert.equal(st.trial.dailyDone, true);
  const again = await begin(u);
  assert.equal(again.status, 429);
  assert.equal(again.body.reason, "trial_daily_done");
  assert.equal(again.body.trial.dailyDone, true);
  assert.equal(again.body.error, "今日のお試しは終了しました（1日30問まで）。日本時間の0時を過ぎると、また使えます。");
});

test("23問の後の start は残り7問で、7問記録で30問になる", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  await noAnswers(u, 23);
  const r = await begin(u);
  assert.equal(r.body.session.total, 7);
  assert.equal(r.body.session.pendingQuestionIds.length, 7);
  for (const id of r.body.session.pendingQuestionIds) await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: id, segmentEnd: "timeout" });
  assert.equal((await u.getJson("/api/instant/status")).body.trial.questionsUsed, 30);
});

test("続きから：途中の回は新しく数えず、同じ回の残りが返る", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  await noAnswers(u, 23);
  const r = await begin(u);
  for (const id of (r.body.session.pendingQuestionIds as string[]).slice(0, 3)) await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: id, segmentEnd: "timeout" });
  const again = await begin(u);
  assert.equal(again.body.resumed, true);
  assert.equal(again.body.session.id, r.body.session.id);
  assert.equal(again.body.session.pendingQuestionIds.length, 4);
  assert.equal((await u.getJson("/api/instant/status")).body.trial.questionsUsed, 26);
});

test("記録の時の拒否：上限に達した後は、回答なし・声のない WAV・声のある WAV とも 429 で、記録も外部 API も全体の数も動かない", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  const r = await begin(u);
  const sid = r.body.session.id as string;
  const ids = r.body.session.pendingQuestionIds as string[];
  setDaily(a, u.key, "2026-10-21", 30);
  const attempts = () => Number(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0]?.n);
  const noAns = await u.postJson("/api/instant/no-answer", { sessionId: sid, questionId: ids[0], segmentEnd: "timeout" });
  assert.equal(noAns.status, 429);
  assert.equal(noAns.body.reason, "trial_daily_done");
  assert.equal(noAns.body.error, "今日のお試しの問題数（1日30問）に達したため、この回答は記録しませんでした。日本時間の0時を過ぎると、また使えます。");
  const silent = await u.postJson("/api/instant/answer", { sessionId: sid, questionId: ids[1], mimeType: "audio/wav", audioBase64: quiet(), segmentEnd: "timeout" });
  assert.equal(silent.status, 429);
  assert.ok(silent.body.audio);
  const calls = a.ai.geminiCalls.length;
  const voice = await u.postJson("/api/instant/answer", { sessionId: sid, questionId: ids[2], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" });
  assert.equal(voice.status, 429);
  assert.equal(voice.body.reason, "trial_daily_done");
  assert.equal(a.ai.geminiCalls.length, calls);
  assert.equal(a.ai.claudeCalls.length, 0);
  assert.equal(attempts(), 0);
  assert.equal(a.db.all("SELECT count FROM daily_counters WHERE name = 'answer'").length, 0);
});

test("全体→人の順：両方いっぱいなら daily_limit で、どちらの数も動かない／全体の上限はみんなの合計", async () => {
  const a = makeTrialApi({ env: { DAILY_ANSWER_LIMIT: "1" } });
  const alice = a.as("Alice");
  const r = await begin(alice);
  const ids = r.body.session.pendingQuestionIds as string[];
  const answer = (i: number, who = alice, sid = r.body.session.id) => who.postJson("/api/instant/answer", { sessionId: sid, questionId: ids[i], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" });
  assert.equal((await answer(0)).status, 200);
  setDaily(a, alice.key, "2026-10-21", 30);
  const limited = await answer(1);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "daily_limit");
  assert.equal(trialToday(a.db, alice.key, "2026-10-21").answers, 30);
  assert.equal(a.db.all("SELECT count FROM daily_counters WHERE name = 'answer'")[0]?.count, 1);
  // 別の人も全体の合計で止まる
  const bob = a.as("Bob");
  const rb = await begin(bob);
  assert.equal(rb.status, 429);
  assert.equal(rb.body.reason, "daily_limit");
});

test("日本時間の0時：14:59:59 は前の日、15:00:00 で新しい日。todayAttempts・trial_daily とも境目で分かれる", async () => {
  const a = makeTrialApi({ now: Date.UTC(2026, 9, 21, 14, 59, 59, 999) });
  const u = a.as("Mika");
  const r = await begin(u);
  const [first, second] = r.body.session.pendingQuestionIds as string[];
  await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: first, segmentEnd: "timeout" });
  assert.equal(trialToday(a.db, u.key, "2026-10-21").answers, 1);
  assert.equal((await u.getJson("/api/instant/status")).body.todayAttempts, 1);
  a.clock.now = Date.UTC(2026, 9, 21, 15, 0, 0, 0);
  assert.equal((await u.getJson("/api/instant/status")).body.todayAttempts, 0);
  assert.equal((await u.getJson("/api/instant/status")).body.trial.questionsUsed, 0);
  await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: second, segmentEnd: "timeout" });
  assert.equal(trialToday(a.db, u.key, "2026-10-22").answers, 1);
  assert.equal((await u.getJson("/api/instant/status")).body.todayAttempts, 1);
  // 前の日に30問だった人も、日付が変われば出題できる
  setDaily(a, u.key, "2026-10-22", 30);
  assert.equal((await begin(u)).status, 429);
  a.clock.now = Date.UTC(2026, 9, 22, 15, 0, 0, 0);
  assert.equal((await begin(u)).status, 200);
});

test("TRIAL_ENDS_ON：当日の23:59:59 は使え、翌0:00 から start・登録を断る。始めた回の記録・読み上げ・履歴は使える", async () => {
  const a = makeTrialApi({ now: Date.UTC(2026, 9, 21, 14, 59, 59), env: { TRIAL_ENDS_ON: DAY1 } });
  const u = a.as("Mika");
  const r = await begin(u);
  assert.equal(r.status, 200);
  const ids = r.body.session.pendingQuestionIds as string[];
  a.clock.now = Date.UTC(2026, 9, 21, 15, 0, 0);
  const blocked = await begin(u); // 続きからの開始も止める
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.reason, "trial_closed");
  assert.equal(blocked.body.error, "お試し期間は終わりました。ご協力ありがとうございました。");
  assert.equal(registerUser(a.db, a.cfg, "Late", null, a.clock.now).reason, "trial_closed");
  assert.equal((await u.getJson("/api/instant/status")).body.trial.closed, true);
  assert.equal((await u.postJson("/api/instant/no-answer", { sessionId: r.body.session.id, questionId: ids[0], segmentEnd: "timeout" })).status, 200);
  const voice = await u.postJson("/api/instant/answer", { sessionId: r.body.session.id, questionId: ids[1], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" });
  assert.equal(voice.status, 200);
  assert.equal((await u.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" })).status, 200);
  assert.equal((await u.getJson("/api/instant/history")).status, 200);
});

test("読み上げ：既定は5回。TRIAL_SPEECH_PER_DAY=2 なら3回目は 429 trial_speech_done で Gemini を呼ばず全体の数も増えない。ほかの人は使える", async () => {
  const a = makeTrialApi({ env: { TRIAL_SPEECH_PER_DAY: "2" } });
  const u = a.as("Mika");
  const speak = (who: TrialApiUser) => who.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" });
  assert.equal((await speak(u)).status, 200);
  assert.equal((await speak(u)).status, 200);
  const calls = a.ai.geminiCalls.length;
  const limited = await speak(u);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "trial_speech_done");
  assert.equal(limited.body.error, "今日の読み上げ（1日2回まで）は終わりました。一度再生した文は、このページを開いている間は何度でも聞けます。日本時間の0時を過ぎると、また使えます。");
  assert.equal(a.ai.geminiCalls.length, calls);
  assert.equal(a.db.all("SELECT count FROM daily_counters WHERE name = 'speech'")[0]?.count, 2);
  assert.equal((await speak(a.as("Bob"))).status, 200);
  assert.equal(trialToday(a.db, u.key, "2026-10-21").speech, 2);
});

test("全体の DAILY_SPEECH_LIMIT はみんなの合計", async () => {
  const a = makeTrialApi({ env: { DAILY_SPEECH_LIMIT: "2" } });
  const speak = (who: TrialApiUser) => who.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" });
  const alice = a.as("Alice"), bob = a.as("Bob");
  assert.equal((await speak(alice)).status, 200);
  assert.equal((await speak(bob)).status, 200);
  const limited = await speak(alice);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.reason, "daily_limit");
  assert.equal(trialToday(a.db, alice.key, "2026-10-21").speech, 1);
});

test("2人の記録が混ざらない（API）：回答・答え合わせ・履歴・読み上げ・リセット・設定・今日の数", async () => {
  const a = makeTrialApi();
  const alice = a.as("Alice"), bob = a.as("Bob");
  const r = await begin(alice);
  const sid = r.body.session.id as string;
  const ids = r.body.session.pendingQuestionIds as string[];
  const rec = await alice.postJson("/api/instant/answer", { sessionId: sid, questionId: ids[0], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" });
  assert.equal(rec.status, 200);
  const attemptId = rec.body.attempt.id as string;
  // bob は alice の出題に答えられない
  assert.equal((await bob.postJson("/api/instant/answer", { sessionId: sid, questionId: ids[1], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" })).status, 409);
  assert.equal((await bob.postJson("/api/instant/no-answer", { sessionId: sid, questionId: ids[1], segmentEnd: "timeout" })).status, 409);
  assert.equal((await bob.postJson("/api/instant/finish", { sessionId: sid, reason: "stopped" })).status, 404);
  await alice.postJson("/api/instant/finish", { sessionId: sid, reason: "stopped" });
  assert.equal((await bob.getJson(`/api/instant/results/${sid}`)).status, 404);
  assert.equal((await alice.getJson(`/api/instant/results/${sid}`)).status, 200);
  const bobHistory = (await bob.getJson("/api/instant/history")).body;
  assert.equal(bobHistory.progress.flatMap((p: any) => p.attempts).length, 0);
  assert.equal((await alice.getJson("/api/instant/history")).body.progress.flatMap((p: any) => p.attempts).length, 1);
  assert.equal((await bob.postJson("/api/instant/speech", { questionId: ids[0], attemptId })).status, 404);
  assert.equal((await alice.postJson("/api/instant/speech", { questionId: ids[0], attemptId })).status, 200);
  // 設定
  await alice.putJson("/api/instant/settings", { questionSeconds: 25, questionCount: 50 });
  assert.deepEqual((await bob.getJson("/api/instant/settings")).body, { questionSeconds: 10, questionCount: 10 });
  // 今日の数
  assert.equal((await alice.getJson("/api/instant/status")).body.trial.questionsUsed, 1);
  assert.equal((await bob.getJson("/api/instant/status")).body.trial.questionsUsed, 0);
  assert.equal((await bob.getJson("/api/instant/status")).body.todayAttempts, 0);
  // bob のリセットは alice に影響しない
  await bob.postJson("/api/instant/reset", {});
  assert.equal((await alice.getJson("/api/instant/status")).body.attempts, 1);
  await alice.postJson("/api/instant/reset", {});
  assert.equal((await alice.getJson("/api/instant/status")).body.attempts, 0);
});

test("リセットしても今日のお試しの数は戻らない（todayAttempts は戻る）。trial_daily と今日の回答の件数は一致する", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  await noAnswers(u, 12);
  const before = (await u.getJson("/api/instant/status")).body;
  assert.equal(before.trial.questionsUsed, 12);
  assert.equal(before.todayAttempts, 12);
  assert.equal(Number(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts WHERE user_key = ?", u.key)[0]?.n), trialToday(a.db, u.key, "2026-10-21").answers);
  await u.postJson("/api/instant/reset", {});
  const after = (await u.getJson("/api/instant/status")).body;
  assert.equal(after.trial.questionsUsed, 12);
  assert.equal(after.todayAttempts, 0);
  assert.equal(after.trial.dailyDone, false);
});

test("参加者の一覧：登録順・今日と累計・今日の読み上げ・lastSeenAt は5分の間引きで更新", async () => {
  const a = makeTrialApi();
  const alice = a.as("Alice");
  a.clock.now += 1000;
  const bob = a.as("Bob");
  await noAnswers(alice, 3);
  setDaily(a, alice.key, "2026-10-20", 7);
  setDaily(a, alice.key, "2026-10-21", 3, 2);
  const list = () => (trialParticipantsReport(a.db, a.env, a.clock.now).participants ?? []);
  const rows = list();
  assert.deepEqual(rows.map((r) => r.name), ["Alice", "Bob"]);
  assert.deepEqual([rows[0]?.todayQuestions, rows[0]?.totalQuestions, rows[0]?.todaySpeech], [3, 10, 2]);
  assert.deepEqual([rows[1]?.todayQuestions, rows[1]?.totalQuestions], [0, 0]);
  // 5分未満の要求では更新しない／5分以上たてば更新する
  const seen0 = list()[1]?.lastSeenAt;
  a.clock.now += 4 * 60_000;
  await bob.getJson("/api/instant/status");
  assert.equal(list()[1]?.lastSeenAt, seen0);
  a.clock.now += 2 * 60_000;
  await bob.getJson("/api/instant/status");
  assert.equal(list()[1]?.lastSeenAt, new Date(a.clock.now).toISOString());
  const report = trialParticipantsReport(a.db, a.env, a.clock.now);
  assert.equal(report.date, "2026-10-21");
  assert.ok(report.daily && typeof report.todayJpy === "number");
  assert.equal(trialParticipantsReport(a.db, { ...a.env, TRIAL_MODE: "" }, a.clock.now).ok, false);
});

test("TRIAL なしで今と同じ：status に trial が無い／/api/trial/me は未知の道と同じ 404／X-User-Key を付けても記録は ''／users・trial_daily は0行", async () => {
  const a = makeApi();
  const st = (await a.getJson("/api/instant/status")).body;
  assert.equal("trial" in st, false);
  assert.equal(typeof st.todayAttempts, "number");
  const me = await a.getJson("/api/trial/me");
  const nothing = await a.getJson("/api/nothing");
  assert.equal(me.status, 404);
  assert.deepEqual(me.body, nothing.body);
  const headers = { [USER_KEY_HEADER]: encodeUserKey("alice") };
  const started = await a.postJson("/api/instant/start", { generationId: st.generationId, questionCount: 20 }, headers);
  assert.equal(started.body.session.total, 20); // 10問に固定されない
  const sid = started.body.session.id;
  await a.postJson("/api/instant/answer", { sessionId: sid, questionId: started.body.session.pendingQuestionIds[0], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" }, headers);
  await a.postJson("/api/instant/no-answer", { sessionId: sid, questionId: started.body.session.pendingQuestionIds[1], segmentEnd: "timeout" }, headers);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts WHERE user_key = ''")[0]?.n, 2);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts WHERE user_key <> ''")[0]?.n, 0);
  assert.equal(a.db.all("SELECT * FROM users").length, 0);
  assert.equal(a.db.all("SELECT * FROM trial_daily").length, 0);
  assert.equal((await a.getJson("/api/instant/status", headers)).body.todayAttempts, 2);
  void T0;
});

test("お試し：speed:slow はゆっくりの指示になり、不正な速さは本人の読み上げ回数を増やさない", async () => {
  const a = makeTrialApi();
  const u = a.as("Mika");
  const s = await begin(u);
  assert.equal(s.status, 200);
  const ids = s.body.session.pendingQuestionIds as string[];
  await u.postJson("/api/instant/finish", { sessionId: s.body.session.id, reason: "stopped" });
  const ok = await u.postJson("/api/instant/speech", { questionId: ids[0], speed: "slow" });
  assert.equal(ok.status, 200);
  assert.match(JSON.stringify(a.ai.geminiCalls.at(-1)), /slightly slower than normal conversation/);
  const used = trialToday(a.db, u.key, DAY1).speech;
  assert.equal(used, 1);
  const bad = await u.postJson("/api/instant/speech", { questionId: ids[0], speed: "fast" });
  assert.equal(bad.status, 400);
  assert.equal(trialToday(a.db, u.key, DAY1).speech, used);
});
