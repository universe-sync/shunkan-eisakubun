import type { PracticeDO } from "./practice-do";

export interface Env {
  ASSETS: Fetcher;
  PRACTICE: DurableObjectNamespace<PracticeDO>;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GATE_PASSWORD?: string;   // 16字以上の合言葉（Secret）。無い・短いと門は閉じたまま
  COOKIE_SECRET?: string;   // 任意（Secret）。32字以上ならこれで cookie に署名する。無ければ合言葉から導く
  // 1日の上限・頻度制限（wrangler.jsonc の vars。文字列）
  DAILY_ANSWER_LIMIT?: string;
  DAILY_YEN_LIMIT?: string;
  DAILY_SPEECH_LIMIT?: string;
  RATE_ANSWER_PER_MINUTE?: string;
  RATE_SPEECH_PER_MINUTE?: string;
}
/** DO の名前。1 個だけ使う */
export const PRACTICE_NAME = "main";
