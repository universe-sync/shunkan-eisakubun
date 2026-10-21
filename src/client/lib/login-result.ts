import { LOGIN } from "../strings.js";

export type LoginOutcome =
  | { kind: "ok" } | { kind: "wrong" } | { kind: "limited"; minutes: number }
  | { kind: "not_configured"; message: string } | { kind: "network" } | { kind: "error" };

/** ログインの応答（状態コードと本文）→ 画面に出す種類。status 0 は通信の失敗 */
export function loginOutcome(status: number, body: unknown): LoginOutcome {
  const obj = typeof body === "object" && body !== null ? (body as { retryAfterSec?: unknown; error?: unknown }) : {};
  if (status === 200) return { kind: "ok" };
  if (status === 401) return { kind: "wrong" };
  if (status === 429) {
    const sec = obj.retryAfterSec;
    const minutes = typeof sec === "number" && Number.isFinite(sec) ? Math.max(1, Math.ceil(sec / 60)) : 10;
    return { kind: "limited", minutes };
  }
  if (status === 503) return { kind: "not_configured", message: typeof obj.error === "string" && obj.error ? obj.error : LOGIN.error };
  if (status === 0) return { kind: "network" };
  return { kind: "error" };
}

/** 誤りの欄に出す文言。ok のときは空 */
export function loginMessage(outcome: LoginOutcome): string {
  switch (outcome.kind) {
    case "ok": return "";
    case "wrong": return LOGIN.wrong;
    case "limited": return LOGIN.limited(outcome.minutes);
    case "not_configured": return outcome.message;
    case "network": return LOGIN.network;
    case "error": return LOGIN.error;
  }
}
