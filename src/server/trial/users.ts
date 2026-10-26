import { NAME_RULE_MESSAGE, NAME_TAKEN_MESSAGE, nameKey, normalizeDisplayName } from "../../shared/trial-rules.js";
import type { Db } from "../store/db";
import type { UserGate } from "../guard/daily-limits";
import { isoMillis, jstDate } from "../time";
import { trialClosed, type TrialConfig } from "./config";

// お試しモードの参加者（users の表）。関数は同期で、確かめと書き込みの間に await を挟まない
export interface TrialRegisterResult { ok: boolean; reason?: "bad_name" | "name_taken" | "trial_closed" | "trial_off"; message?: string; key?: string; displayName?: string }

export const TRIAL_CLOSED_MESSAGE = "お試し期間は終わりました。ご協力ありがとうございました。";

/** 名前を登録する。同じ鍵で currentKey も同じなら（二度押し・読み込み直し）そのまま ok。ほかの人が使っている鍵は name_taken */
export function registerUser(db: Db, cfg: TrialConfig, input: unknown, currentKey: string | null, now: number): TrialRegisterResult {
  if (!cfg.enabled) return { ok: false, reason: "trial_off" };
  if (trialClosed(cfg, now)) return { ok: false, reason: "trial_closed", message: TRIAL_CLOSED_MESSAGE };
  const display = normalizeDisplayName(input);
  if (display === null) return { ok: false, reason: "bad_name", message: NAME_RULE_MESSAGE };
  const key = nameKey(display);
  return db.transaction((): TrialRegisterResult => {
    const row = db.all("SELECT display_name FROM users WHERE user_key = ?", key)[0];
    const at = isoMillis(now);
    if (row) {
      if (key !== currentKey) return { ok: false, reason: "name_taken", message: NAME_TAKEN_MESSAGE };
      db.run("UPDATE users SET last_seen_at = ? WHERE user_key = ?", at, key);
      return { ok: true, key, displayName: String(row.display_name) };
    }
    db.run("INSERT INTO users (user_key, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)", key, display, at, at);
    return { ok: true, key, displayName: display };
  });
}

export function findUser(db: Db, key: string): { key: string; displayName: string } | null {
  const row = db.all("SELECT user_key, display_name FROM users WHERE user_key = ?", key)[0];
  return row ? { key: String(row.user_key), displayName: String(row.display_name) } : null;
}

// ---- 段C：1日の数・参加者の一覧 ----

export function trialToday(db: Db, key: string, day: string): { answers: number; speech: number } {
  const row = db.all("SELECT answers, speech FROM trial_daily WHERE user_key = ? AND day = ?", key, day)[0];
  return { answers: row ? Number(row.answers) : 0, speech: row ? Number(row.speech) : 0 };
}
/** 記録された回答を1つ数える（store.record の同じトランザクションの中から呼ぶ） */
export function addTrialAnswer(db: Db, key: string, day: string): void {
  db.run("INSERT INTO trial_daily (user_key, day, answers, speech) VALUES (?, ?, 1, 0) ON CONFLICT (user_key, day) DO UPDATE SET answers = answers + 1", key, day);
}
export function addTrialSpeech(db: Db, key: string, day: string): void {
  db.run("INSERT INTO trial_daily (user_key, day, answers, speech) VALUES (?, ?, 0, 1) ON CONFLICT (user_key, day) DO UPDATE SET speech = speech + 1", key, day);
}
/** 最後に使った時刻を更新する。5分より古いときだけ（要求のたびに書かない） */
export function touchUser(db: Db, key: string, now: number): void {
  const row = db.all("SELECT last_seen_at FROM users WHERE user_key = ?", key)[0];
  if (!row) return;
  const last = Date.parse(String(row.last_seen_at));
  if (Number.isFinite(last) && now - last < 5 * 60_000) return;
  db.run("UPDATE users SET last_seen_at = ? WHERE user_key = ?", isoMillis(now), key);
}

export interface TrialInfo { name: string; questionsUsed: number; questionsLimit: number; speechUsed: number; speechLimit: number; endsOn: string | null; closed: boolean; dailyDone: boolean }
export function trialInfo(db: Db, cfg: TrialConfig, key: string, now: number): TrialInfo {
  const today = trialToday(db, key, jstDate(now));
  return {
    name: findUser(db, key)?.displayName ?? "",
    questionsUsed: today.answers, questionsLimit: cfg.questionsPerDay,
    speechUsed: today.speech, speechLimit: cfg.speechPerDay,
    endsOn: cfg.endsOn, closed: trialClosed(cfg, now), dailyDone: today.answers >= cfg.questionsPerDay,
  };
}
/** 1日の回答の上限（人ごと）。reserveDaily の user に渡す */
export function answerGate(db: Db, cfg: TrialConfig, key: string): UserGate {
  return { check: (day) => (trialToday(db, key, day).answers >= cfg.questionsPerDay ? "trial_answers" : null) };
}
/** 1日の読み上げの上限（人ごと）。通ったら commit で数える（Gemini を呼ぶ直前に数える） */
export function speechGate(db: Db, cfg: TrialConfig, key: string): UserGate {
  return {
    check: (day) => (trialToday(db, key, day).speech >= cfg.speechPerDay ? "trial_speech" : null),
    commit: (day) => { addTrialSpeech(db, key, day); },
  };
}

export interface TrialParticipant { name: string; todayQuestions: number; totalQuestions: number; todaySpeech: number; lastSeenAt: string; createdAt: string }
export function listParticipants(db: Db, now: number): TrialParticipant[] {
  return db.all(
    `SELECT u.display_name, u.created_at, u.last_seen_at,
  COALESCE(t.answers, 0) AS today_answers, COALESCE(t.speech, 0) AS today_speech,
  (SELECT COALESCE(SUM(a.answers), 0) FROM trial_daily a WHERE a.user_key = u.user_key) AS total_answers
FROM users u LEFT JOIN trial_daily t ON t.user_key = u.user_key AND t.day = ?
ORDER BY u.created_at, u.user_key`, jstDate(now),
  ).map((r) => ({ name: String(r.display_name), todayQuestions: Number(r.today_answers), totalQuestions: Number(r.total_answers), todaySpeech: Number(r.today_speech), lastSeenAt: String(r.last_seen_at), createdAt: String(r.created_at) }));
}
