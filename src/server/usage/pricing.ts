// API（Gemini・Claude）の単価（100万トークンあたりの USD）と円換算の目安。サーバー専用。
// 出典：Gemini https://ai.google.dev/gemini-api/docs/pricing（有料・Standard。2026-10-20 に確認。ページの最終更新 2026-10-19 UTC）／Claude https://platform.claude.com/docs/en/about-claude/pricing（2026-10-20 に確認）
// 単価を変えたら PRICING_CHECKED_ON も直す。単価の無いモデルは金額を出さない（推測の数字を出さない）。
export const PRICING_SOURCES = Object.freeze({ gemini: "https://ai.google.dev/gemini-api/docs/pricing", claude: "https://platform.claude.com/docs/en/about-claude/pricing" });
export const PRICING_CHECKED_ON = "2026-10-20";
// 1ドル=156円（2026-10 時点の目安）
export const USD_JPY = 156;
// Gemini の料金表：2026-12-31 までは安い単価、2027-01-01 から通常の単価（2倍）。タイムゾーンの記載が無いので UTC の0時で切り替える（この日は含まない）
const FLASH_UNTIL = "2027-01-01";
export interface Price { inputPerMTok: number; cachedInputPerMTok?: number; cacheWrite5mPerMTok?: number; cacheWrite1hPerMTok?: number; audioInputPerMTok?: number; outputPerMTok: number; longPrompt?: Price & { overInputTokens: number }; until?: string }
export interface ModelPricing { regular: Price; intro?: Price & { until: string } }
export const API_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // 入力は文字・画像・動画・音声とも同じ単価（料金表に音声の別単価が無い）。出力は thinking を含む
  "gemini-3.8-flash": Object.freeze({
    regular: Object.freeze({ inputPerMTok: 1.5, cachedInputPerMTok: 0.15, outputPerMTok: 7.5 }),
    intro: Object.freeze({ inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 3.75, until: FLASH_UNTIL })
  }),
  // 聞き取り専用。料金表：音声入力 $2.00（または $0.003/分）・テキスト出力 $12.00（または $0.002/分）。文字の入力の単価は記載が無いので音声と同じ 2.0 で数える（多めの見積もり）。intro は無し
  // 出典 https://ai.google.dev/gemini-api/docs/pricing ・ https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe（2026-10-20 に確認）
  "gemini-3.5-transcribe": Object.freeze({
    regular: Object.freeze({ inputPerMTok: 2.0, outputPerMTok: 12.0 })
  }),
  // 入力は文字、出力は音声。キャッシュの単価は料金表に無いので、キャッシュ分も通常の入力単価で数える
  "gemini-3.8-flash-tts": Object.freeze({
    regular: Object.freeze({ inputPerMTok: 1.0, outputPerMTok: 18.0 }),
    intro: Object.freeze({ inputPerMTok: 0.5, outputPerMTok: 9.0, until: FLASH_UNTIL })
  }),
  // Claude Haiku 5.5：プロンプト（キャッシュの読み書きを含む入力の全部）が10万トークンを超えると高い単価。thinking は output_tokens に含まれる
  "claude-haiku-5-5": Object.freeze({
    regular: Object.freeze({
      inputPerMTok: 0.10, cachedInputPerMTok: 0.01, cacheWrite5mPerMTok: 0.125, cacheWrite1hPerMTok: 0.20, outputPerMTok: 0.50,
      longPrompt: Object.freeze({ overInputTokens: 100_000, inputPerMTok: 0.50, cachedInputPerMTok: 0.05, cacheWrite5mPerMTok: 0.625, cacheWrite1hPerMTok: 1.0, outputPerMTok: 2.50 })
    })
  })
});
export const providerOf = (model: unknown): "claude" | "gemini" | "other" => (typeof model !== "string" ? "other" : model.startsWith("claude-") ? "claude" : model.startsWith("gemini-") ? "gemini" : "other");

export function resolvePricing(model: string, now: Date = new Date(), table: Readonly<Record<string, ModelPricing>> = API_PRICING): Price | null {
  const pricing = table[model];
  if (!pricing) return null;
  return pricing.intro && now < new Date(`${pricing.intro.until}T00:00:00Z`) ? pricing.intro : pricing.regular;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// 配列（[{ modality, tokens }]）でも、モダリティ名をキーにしたオブジェクトでも読む
function modalityEntries(value: unknown): { modality: string; tokens: number }[] {
  if (Array.isArray(value)) {
    return (value as any[]).filter((item) => item && typeof item === "object").map((item) => ({ modality: String(item.modality ?? item.type ?? "").toLowerCase(), tokens: count(item.tokens ?? item.token_count ?? item.count) }));
  }
  if (value && typeof value === "object") return Object.entries(value).map(([modality, tokens]) => ({ modality: modality.toLowerCase(), tokens: count(tokens) }));
  return [];
}
const modalityTotal = (value: unknown): number => modalityEntries(value).reduce((sum, item) => sum + item.tokens, 0);
const modalityAudio = (value: unknown): number => modalityEntries(value).filter((item) => item.modality === "audio").reduce((sum, item) => sum + item.tokens, 0);

export interface NormalizedUsage { missing: boolean; inputTokens: number; audioInputTokens: number; cachedTokens: number; cachedAudioTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; outputTokens: number; thoughtTokens: number; toolUseTokens: number }
const MISSING: Readonly<NormalizedUsage> = Object.freeze({ missing: true, inputTokens: 0, audioInputTokens: 0, cachedTokens: 0, cachedAudioTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, thoughtTokens: 0, toolUseTokens: 0 });

// Messages API の usage。input_tokens はキャッシュの読み書きを含まないので足して「入力の全部」にそろえる。
// thinking は output_tokens に含まれ、output_tokens_details.thinking_tokens はその内訳（SDK の型の説明）。
// 二重に数えないよう、outputTokens = output − thinking、thoughtTokens = thinking に分ける（costUsd は両方を足して出力の単価を掛ける）
function normalizeClaudeUsage(usage: any): NormalizedUsage {
  if (!usage || typeof usage !== "object" || (!isNumber(usage.input_tokens) && !isNumber(usage.output_tokens))) return { ...MISSING };
  const creation = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const write1h = count(creation?.ephemeral_1h_input_tokens);
  const write5m = Math.max(count(creation?.ephemeral_5m_input_tokens), count(usage.cache_creation_input_tokens) - write1h); // 内訳が無ければ全部を5分として数える
  const cacheRead = count(usage.cache_read_input_tokens);
  const output = count(usage.output_tokens);
  const thinking = Math.min(output, count(usage.output_tokens_details?.thinking_tokens));
  return { missing: false, inputTokens: count(usage.input_tokens) + cacheRead + write5m + write1h, audioInputTokens: 0, cachedTokens: cacheRead, cachedAudioTokens: 0, cacheWriteTokens: write5m, cacheWrite1hTokens: write1h, outputTokens: output - thinking, thoughtTokens: thinking, toolUseTokens: 0 };
}

// 使用量を、課金の計算に使う形にそろえる。使用量が返らなかったときは missing: true。
// model が Claude なら Messages API の usage、それ以外（省略を含む）は Gemini の Interactions API の usage として読む
export function normalizeUsage(usage: any, model?: unknown): NormalizedUsage {
  if (providerOf(model) === "claude") return normalizeClaudeUsage(usage);
  if (!usage || typeof usage !== "object") return { ...MISSING };
  const known = ["total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_tokens"];
  if (!known.some((key) => isNumber(usage[key]))) return { ...MISSING };
  const inputTokens = isNumber(usage.total_input_tokens) ? count(usage.total_input_tokens) : modalityTotal(usage.input_tokens_by_modality);
  const audioInputTokens = Math.min(inputTokens, modalityAudio(usage.input_tokens_by_modality));
  const cachedRaw = isNumber(usage.total_cached_tokens) ? count(usage.total_cached_tokens) : modalityTotal(usage.cached_tokens_by_modality);
  const cachedTokens = Math.min(inputTokens, cachedRaw);
  const cachedAudioTokens = Math.min(cachedTokens, audioInputTokens, modalityAudio(usage.cached_tokens_by_modality));
  const outputTokens = isNumber(usage.total_output_tokens) ? count(usage.total_output_tokens) : modalityTotal(usage.output_tokens_by_modality);
  return {
    missing: false,
    inputTokens,
    audioInputTokens,
    cachedTokens,
    cachedAudioTokens,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens,
    thoughtTokens: count(usage.total_thought_tokens),
    toolUseTokens: count(usage.total_tool_use_tokens)
  };
}

// 単価の無いモデルは null。thinking は出力として数える（Gemini は多めに見積もる側、Claude は output_tokens に含まれるので内訳を足し戻す）
export function costUsd(model: string, normalized: NormalizedUsage, now: Date = new Date(), table: Readonly<Record<string, ModelPricing>> = API_PRICING): number | null {
  const base = resolvePricing(model, now, table);
  if (!base) return null;
  const price = base.longPrompt && normalized.inputTokens > base.longPrompt.overInputTokens ? base.longPrompt : base;
  const writes5m = normalized.cacheWriteTokens || 0;
  const writes1h = normalized.cacheWrite1hTokens || 0;
  const uncachedAudio = normalized.audioInputTokens - normalized.cachedAudioTokens;
  const uncachedOther = Math.max(0, normalized.inputTokens - normalized.cachedTokens - writes5m - writes1h - uncachedAudio) + normalized.toolUseTokens;
  return (
    uncachedOther * price.inputPerMTok +
    uncachedAudio * (price.audioInputPerMTok ?? price.inputPerMTok) +
    normalized.cachedTokens * (price.cachedInputPerMTok ?? price.inputPerMTok) +
    writes5m * (price.cacheWrite5mPerMTok ?? price.inputPerMTok) +
    writes1h * (price.cacheWrite1hPerMTok ?? price.inputPerMTok) +
    (normalized.outputTokens + normalized.thoughtTokens) * price.outputPerMTok
  ) / 1_000_000;
}
