export interface LoginRule { windowMs: number; maxPerKey: number; maxTotal: number }
export const LOGIN_RULE: LoginRule = { windowMs: 10 * 60 * 1000, maxPerKey: 5, maxTotal: 30 };
export type LoginDecision =
  | { result: "ok" }
  | { result: "wrong" }
  | { result: "limited"; retryAfterSec: number };

/** 窓の中の失敗が上限以上のとき、いつ空くか（ms）。上限に達していなければ null */
function waitMs(times: readonly number[], max: number, now: number, windowMs: number): number | null {
  if (times.length < max) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const oldestToExpire = sorted[times.length - max] as number;
  return oldestToExpire + windowMs - now;
}

/** mine：この key の失敗の時刻（ms）、all：全体の失敗の時刻。どちらも順不同でよい */
export function decideLogin(i: { ok: boolean; mine: readonly number[]; all: readonly number[]; now: number; rule?: LoginRule }): LoginDecision {
  const rule = i.rule ?? LOGIN_RULE;
  const since = i.now - rule.windowMs;
  const mine = i.mine.filter((t) => t > since);
  const all = i.all.filter((t) => t > since);
  const a = waitMs(mine, rule.maxPerKey, i.now, rule.windowMs);
  const b = waitMs(all, rule.maxTotal, i.now, rule.windowMs);
  if (a !== null || b !== null) {
    const ms = Math.max(a ?? 0, b ?? 0);
    return { result: "limited", retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) };
  }
  return i.ok ? { result: "ok" } : { result: "wrong" };
}
