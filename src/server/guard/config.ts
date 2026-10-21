// 1日の上限・頻度制限の値。wrangler.jsonc の vars（文字列）から読む。数字だけを受け、範囲を外れたら既定に戻す
export interface GuardEnv {
  DAILY_ANSWER_LIMIT?: string;
  DAILY_YEN_LIMIT?: string;
  DAILY_SPEECH_LIMIT?: string;
  RATE_ANSWER_PER_MINUTE?: string;
  RATE_SPEECH_PER_MINUTE?: string;
}
export interface GuardConfig {
  dailyAnswers: number;
  dailyYen: number;
  dailySpeech: number;
  rateAnswerPerMinute: number;
  rateSpeechPerMinute: number;
}

export const GUARD_DEFAULTS: GuardConfig = { dailyAnswers: 300, dailyYen: 50, dailySpeech: 100, rateAnswerPerMinute: 40, rateSpeechPerMinute: 30 };

const FIELDS: ReadonlyArray<{ env: keyof GuardEnv; key: keyof GuardConfig; min: number; max: number }> = [
  { env: "DAILY_ANSWER_LIMIT", key: "dailyAnswers", min: 1, max: 5000 },
  { env: "DAILY_YEN_LIMIT", key: "dailyYen", min: 1, max: 10000 },
  { env: "DAILY_SPEECH_LIMIT", key: "dailySpeech", min: 1, max: 2000 },
  { env: "RATE_ANSWER_PER_MINUTE", key: "rateAnswerPerMinute", min: 1, max: 600 },
  { env: "RATE_SPEECH_PER_MINUTE", key: "rateSpeechPerMinute", min: 1, max: 600 },
];

const warned = new Set<string>();

export function guardConfig(env: GuardEnv): GuardConfig {
  const out: GuardConfig = { ...GUARD_DEFAULTS };
  for (const f of FIELDS) {
    const raw = env[f.env];
    if (raw === undefined || raw === "") continue;
    const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= f.min && n <= f.max) { out[f.key] = n; continue; }
    if (!warned.has(f.env)) { warned.add(f.env); console.warn(`${f.env} の値が正しくないため、既定の値（${GUARD_DEFAULTS[f.key]}）を使います。`); }
  }
  return out;
}
