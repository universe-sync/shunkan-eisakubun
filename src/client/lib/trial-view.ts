import { TRIAL_SESSION_SIZE } from "../../shared/trial-rules.js";

// お試しモードの画面の判断（純粋な関数）。サーバーの status.trial / /api/trial/me の形を確かめて使う
export type TrialInfo = { name: string; questionsUsed: number; questionsLimit: number; speechUsed: number; speechLimit: number; endsOn: string | null; closed: boolean; dailyDone: boolean };

export const TRIAL_CLOSED_TEXT = "お試し期間は終わりました。ご協力ありがとうございました。";
export const TRIAL_DAILY_DONE_TEXT = "今日のお試しは終了しました（日本時間の0時を過ぎると、また使えます）。";

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 壊れた形・足りない項目は null（1人用と区別するため、一部だけ正しい値は受け付けない） */
export function parseTrialInfo(value: unknown): TrialInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, questionsUsed, questionsLimit, speechUsed, speechLimit, endsOn, closed, dailyDone } = value as Record<string, unknown>;
  if (typeof name !== "string" || !count(questionsUsed) || !count(questionsLimit) || !count(speechUsed) || !count(speechLimit)) return null;
  if (typeof closed !== "boolean" || typeof dailyDone !== "boolean") return null;
  let ends: string | null;
  if (endsOn === null) ends = null;
  else if (typeof endsOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endsOn)) ends = endsOn;
  else return null;
  return { name, questionsUsed, questionsLimit, speechUsed, speechLimit, endsOn: ends, closed, dailyDone };
}
export const trialRemaining = (t: TrialInfo): number => Math.max(0, t.questionsLimit - t.questionsUsed);
export const trialSpeechRemaining = (t: TrialInfo): number => Math.max(0, t.speechLimit - t.speechUsed);
/** 出題を始められない理由（終了日の後を先に、その次に今日の分）。始められるなら null */
export function trialBlockedMessage(t: TrialInfo): string | null {
  if (t.closed) return TRIAL_CLOSED_TEXT;
  if (t.dailyDone || trialRemaining(t) <= 0) return TRIAL_DAILY_DONE_TEXT;
  return null;
}
/** 次の出題の問題数。1回10問・今日の残り・未クリアの数のどれか小さい方 */
export const trialNextCount = (t: TrialInfo, uncleared: number): number => Math.min(TRIAL_SESSION_SIZE, trialRemaining(t), uncleared);
/** 日本時間の次の0時までのミリ秒（0時ちょうどなら1日分） */
export const msUntilJstMidnight = (nowMs: number): number => 86_400_000 - ((nowMs + 9 * 3_600_000) % 86_400_000);
/** "2026-10-21" → "10月21日" */
export const endsOnLabel = (endsOn: string): string => `${Number(endsOn.slice(5, 7))}月${Number(endsOn.slice(8, 10))}日`;
/** 画面の上の帯の文 */
export function trialBarText(t: TrialInfo): string {
  if (t.closed) return "お試し期間は終わりました";
  if (t.dailyDone) return `${t.name}さん・${TRIAL_DAILY_DONE_TEXT.replace(/。$/, "")}`;
  const until = t.endsOn ? `・${endsOnLabel(t.endsOn)}まで` : "";
  return `${t.name}さん・今日の残り ${trialRemaining(t)}問・読み上げ残り ${trialSpeechRemaining(t)}回${until}`;
}
