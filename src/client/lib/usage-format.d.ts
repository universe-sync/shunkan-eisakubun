export type UsagePeriod = { calls: number; pricedCalls: number; unpricedCalls: number; missingUsageCalls: number; usd: number; jpy: number };
export function formatYen(jpy: number): string;
export function formatPeriod(period: UsagePeriod): string;
export type UsageBreakdown = { gemini: UsagePeriod; claude: UsagePeriod };
export function formatBreakdown(byProvider: UsageBreakdown | undefined): string;
export type DailyUsage = {
  answers: { used: number; limit: number }; speech: { used: number; limit: number }; yen: { used: number; limit: number };
  reached: { answers: boolean; speech: boolean; yen: boolean };
};
export function formatDaily(daily: DailyUsage): string;
export function dailyReached(daily: DailyUsage): boolean;
