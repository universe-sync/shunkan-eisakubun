import type { Db, SqlRow } from "../store/db";
import { jstDate } from "../time";
import { PRICING_CHECKED_ON, PRICING_SOURCES, USD_JPY, costUsd, normalizeUsage, providerOf } from "./pricing";

// API（Gemini・Claude）の利用料の目安を積み上げる記録係。保存するのは日付・モデル・回数・トークン数・USD だけ（音声と文字は保存しない）。
// 日の表（usage_days）と累計の表（usage_totals）に、transaction の中で同時に足す。関数は同期（DO が割り込まないため）

type Period = { calls: number; pricedCalls: number; unpricedCalls: number; missingUsageCalls: number; usd: number; jpy: number };
const emptyPeriod = (): Period => ({ calls: 0, pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0 });
// 記録を読むときは、負の数や数でない値を 0 にしてから足す
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function addRow(period: Period, row: SqlRow): void {
  period.calls += num(row.calls);
  period.unpricedCalls += num(row.unpriced_calls);
  period.missingUsageCalls += num(row.missing_usage_calls);
  period.usd += num(row.usd);
}
function finishPeriod(period: Period): Period {
  period.pricedCalls = Math.max(0, period.calls - period.unpricedCalls);
  period.jpy = period.usd * USD_JPY;
  return period;
}

export type UsageSummary = {
  today: Period & { date: string; byProvider: { gemini: Period; claude: Period } };
  total: Period & { since: string | null; byProvider: { gemini: Period; claude: Period } };
  usdJpy: number;
  pricing: { sources: typeof PRICING_SOURCES; checkedOn: string };
};
export interface UsageStore {
  record(model: unknown, rawUsage: unknown): UsageSummary;
  summary(): UsageSummary;
  /** 今日（日本時間）の利用料の見積もり（円）。段2の1日の上限で使う */
  todayJpy(): number;
}

export function createUsageStore(db: Db, now: () => number): UsageStore {
  const summary = (): UsageSummary => {
    const today = jstDate(now());
    const todayRows = db.all("SELECT model, calls, missing_usage_calls, unpriced_calls, usd FROM usage_days WHERE day = ?", today);
    const totalRows = db.all("SELECT model, calls, missing_usage_calls, unpriced_calls, usd FROM usage_totals");
    const sinceRow = db.all("SELECT day FROM usage_days ORDER BY day LIMIT 1")[0];
    const todayPeriod = emptyPeriod();
    const totalPeriod = emptyPeriod();
    const todayBy = { gemini: emptyPeriod(), claude: emptyPeriod() };
    const totalBy = { gemini: emptyPeriod(), claude: emptyPeriod() };
    for (const row of totalRows) {
      const provider = providerOf(row.model); // "other"（unknown など）は合計にだけ入れる
      addRow(totalPeriod, row);
      if (provider !== "other") addRow(totalBy[provider], row);
    }
    for (const row of todayRows) {
      const provider = providerOf(row.model);
      addRow(todayPeriod, row);
      if (provider !== "other") addRow(todayBy[provider], row);
    }
    return {
      today: { date: today, ...finishPeriod(todayPeriod), byProvider: { gemini: finishPeriod(todayBy.gemini), claude: finishPeriod(todayBy.claude) } },
      total: { since: sinceRow ? String(sinceRow.day) : null, ...finishPeriod(totalPeriod), byProvider: { gemini: finishPeriod(totalBy.gemini), claude: finishPeriod(totalBy.claude) } },
      usdJpy: USD_JPY,
      pricing: { sources: PRICING_SOURCES, checkedOn: PRICING_CHECKED_ON },
    };
  };
  return {
    record(model, rawUsage) {
      const at = now();
      const modelKey = typeof model === "string" && /^[a-z0-9.-]{1,80}$/.test(model) ? model : "unknown";
      const usage = normalizeUsage(rawUsage, modelKey);
      const usd = costUsd(modelKey, usage, new Date(at));
      const missing = usage.missing ? 1 : 0;
      const unpriced = usd === null ? 1 : 0;
      const add = usd === null ? 0 : num(usd);
      db.transaction(() => {
        db.run(
          `INSERT INTO usage_days (day, model, calls, missing_usage_calls, unpriced_calls, input_tokens, audio_input_tokens, cached_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens, thought_tokens, tool_use_tokens, usd)
VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (day, model) DO UPDATE SET calls = calls + 1, missing_usage_calls = missing_usage_calls + excluded.missing_usage_calls, unpriced_calls = unpriced_calls + excluded.unpriced_calls, input_tokens = input_tokens + excluded.input_tokens, audio_input_tokens = audio_input_tokens + excluded.audio_input_tokens, cached_tokens = cached_tokens + excluded.cached_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens, output_tokens = output_tokens + excluded.output_tokens, thought_tokens = thought_tokens + excluded.thought_tokens, tool_use_tokens = tool_use_tokens + excluded.tool_use_tokens, usd = usd + excluded.usd`,
          jstDate(at), modelKey, missing, unpriced, num(usage.inputTokens), num(usage.audioInputTokens), num(usage.cachedTokens), num(usage.cacheWriteTokens), num(usage.cacheWrite1hTokens), num(usage.outputTokens), num(usage.thoughtTokens), num(usage.toolUseTokens), add,
        );
        db.run(
          `INSERT INTO usage_totals (model, calls, missing_usage_calls, unpriced_calls, usd) VALUES (?, 1, ?, ?, ?)
ON CONFLICT (model) DO UPDATE SET calls = calls + 1, missing_usage_calls = missing_usage_calls + excluded.missing_usage_calls, unpriced_calls = unpriced_calls + excluded.unpriced_calls, usd = usd + excluded.usd`,
          modelKey, missing, unpriced, add,
        );
      });
      return summary();
    },
    summary,
    todayJpy(): number {
      const rows = db.all("SELECT usd FROM usage_days WHERE day = ?", jstDate(now()));
      return rows.reduce((sum, row) => sum + num(row.usd), 0) * USD_JPY;
    },
  };
}
