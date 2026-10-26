import type { Db } from "../store/db";
import { jstDate } from "../time";
import type { GuardConfig } from "./config";

// 1日の上限（日本時間で区切る）。費用がかかる所（聞き取り＋採点・読み上げ）だけを数える。関数は同期（DO が割り込まないため）
export type DailyKind = "answer" | "speech";
export type DailyLimit = "answers" | "speech" | "yen";
export interface DailyState {
  date: string;
  answers: { used: number; limit: number };
  speech: { used: number; limit: number };
  yen: { used: number; limit: number };
  reached: { answers: boolean; speech: boolean; yen: boolean };
}

function counter(db: Db, day: string, name: DailyKind): number {
  const row = db.all("SELECT count FROM daily_counters WHERE day = ? AND name = ?", day, name)[0];
  return row ? Number(row.count) : 0;
}

export function dailyState(db: Db, cfg: GuardConfig, now: number, todayJpy: number): DailyState {
  const day = jstDate(now);
  const answers = counter(db, day, "answer");
  const speech = counter(db, day, "speech");
  return {
    date: day,
    answers: { used: answers, limit: cfg.dailyAnswers },
    speech: { used: speech, limit: cfg.dailySpeech },
    yen: { used: todayJpy, limit: cfg.dailyYen },
    reached: { answers: answers >= cfg.dailyAnswers, speech: speech >= cfg.dailySpeech, yen: todayJpy >= cfg.dailyYen },
  };
}

/** 円が上限以上ならだめ、全体の回数が上限以上ならだめ、人ごとの上限（user）に達していてもだめ。どれでもなければ数を＋1する。7日より前の行はここで消す */
export type UserLimit = "trial_answers" | "trial_speech";
/** お試しモードの人ごとの上限。check が上限を返したら全体は数えず断る。commit は全体を足した後に呼ぶ（読み上げの人ごとの数など） */
export interface UserGate { check(day: string): UserLimit | null; commit?(day: string): void }
export interface DailyReserve { ok: boolean; limit?: DailyLimit; user?: UserLimit }  // 判別つきの共用体にしないのは、テスト用の tsconfig（strictNullChecks なし）でも読めるようにするため
export function reserveDaily(db: Db, cfg: GuardConfig, kind: DailyKind, now: number, todayJpy: number, user?: UserGate): DailyReserve {
  const day = jstDate(now);
  return db.transaction(() => {
    db.run("DELETE FROM daily_counters WHERE day < ?", jstDate(now - 7 * 86_400_000));
    if (todayJpy >= cfg.dailyYen) return { ok: false, limit: "yen" };
    const limit = kind === "answer" ? cfg.dailyAnswers : cfg.dailySpeech;
    if (counter(db, day, kind) >= limit) return { ok: false, limit: kind === "answer" ? "answers" : "speech" };
    const userLimit = user?.check(day) ?? null;
    if (userLimit) return { ok: false, user: userLimit }; // 全体はまだ足さない
    db.run("INSERT INTO daily_counters (day, name, count) VALUES (?, ?, 1) ON CONFLICT (day, name) DO UPDATE SET count = count + 1", day, kind);
    user?.commit?.(day);
    return { ok: true };
  });
}

/** start 用：数えずに、回数か円が上限に達しているかだけを見る（答え側の上限） */
export function checkAnswerCapacity(db: Db, cfg: GuardConfig, now: number, todayJpy: number): DailyReserve {
  if (todayJpy >= cfg.dailyYen) return { ok: false, limit: "yen" };
  if (counter(db, jstDate(now), "answer") >= cfg.dailyAnswers) return { ok: false, limit: "answers" };
  return { ok: true };
}

export function dailyLimitMessage(limit: DailyLimit, cfg: GuardConfig): string {
  if (limit === "answers") return `今日の採点の上限（${cfg.dailyAnswers}回）に達しました。日本時間の0時を過ぎると、また採点できます。`;
  if (limit === "yen") return `今日の利用料の上限（約${cfg.dailyYen}円）に達しました。日本時間の0時を過ぎると、また使えます。`;
  return `今日の読み上げの上限（${cfg.dailySpeech}回）に達しました。日本時間の0時を過ぎると、また使えます。`;
}
