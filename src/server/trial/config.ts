import { jstDate } from "../time";

// お試しモードの設定（wrangler の vars。文字列）。TRIAL_MODE が "1" のときだけ有効
export interface TrialEnv { TRIAL_MODE?: string; TRIAL_QUESTIONS_PER_DAY?: string; TRIAL_SPEECH_PER_DAY?: string; TRIAL_ENDS_ON?: string }
export interface TrialConfig { enabled: boolean; questionsPerDay: number; speechPerDay: number; endsOn: string | null }
export const TRIAL_DEFAULTS = { questionsPerDay: 30, speechPerDay: 5 };

export const trialEnabled = (env: { TRIAL_MODE?: string }): boolean => env.TRIAL_MODE === "1";

const warned = new Set<string>();
/** 試験用：警告の「1回だけ」を戻す */
export function resetTrialWarnings(): void { warned.clear(); }
const warnOnce = (key: string, message: string): void => { if (!warned.has(key)) { warned.add(key); console.warn(message); } };

function count(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 500) return n;
  warnOnce(key, `${key} の値が正しくないため、既定の値（${fallback}）を使います。`);
  return fallback;
}

export function trialConfig(env: TrialEnv): TrialConfig {
  let endsOn: string | null = null;
  const raw = env.TRIAL_ENDS_ON;
  if (raw !== undefined && raw !== "") {
    const date = new Date(`${raw}T00:00:00Z`);
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
    if (ok) endsOn = raw;
    else warnOnce("TRIAL_ENDS_ON", "TRIAL_ENDS_ON の値が正しくないため、終了日は無いものとして扱います。");
  }
  return {
    enabled: trialEnabled(env),
    questionsPerDay: count(env.TRIAL_QUESTIONS_PER_DAY, "TRIAL_QUESTIONS_PER_DAY", TRIAL_DEFAULTS.questionsPerDay),
    speechPerDay: count(env.TRIAL_SPEECH_PER_DAY, "TRIAL_SPEECH_PER_DAY", TRIAL_DEFAULTS.speechPerDay),
    endsOn,
  };
}

/** 終了日（その日を含む。日本時間の24時まで）を過ぎたか */
export function trialClosed(cfg: TrialConfig, now: number): boolean {
  return cfg.endsOn !== null && jstDate(now) > cfg.endsOn;
}
