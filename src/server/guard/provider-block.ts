// 外部 API の上限・残高切れ・キーの誤りを受けた提供元を、一定時間呼ばないようにする（無駄な課金や呼び出しを防ぐ）。
// DO のメモリだけに持つ。DO が動き直すと消える（secret を変えると新しい版になり、DO も動き直す）
export type Provider = "claude" | "gemini";
export const PROVIDER_BLOCK_MS = 10 * 60 * 1000;

export interface ProviderBlock { provider: Provider; reason: string; message: string }
export interface ProviderBlocker {
  block(provider: Provider, reason: string, message: string, now: number): void;
  /** 止めている間はその内容。期限が過ぎたら消して null */
  active(provider: Provider, now: number): ProviderBlock | null;
  /** status に出す：止めているもののうち最初の1つ */
  any(now: number): ProviderBlock | null;
}

export function createProviderBlocker(): ProviderBlocker {
  const blocks = new Map<Provider, ProviderBlock & { until: number }>();
  const active = (provider: Provider, now: number): ProviderBlock | null => {
    const b = blocks.get(provider);
    if (!b) return null;
    if (now >= b.until) { blocks.delete(provider); return null; }
    return { provider: b.provider, reason: b.reason, message: b.message };
  };
  return {
    block(provider, reason, message, now) { blocks.set(provider, { provider, reason, message, until: now + PROVIDER_BLOCK_MS }); },
    active,
    any(now) { return active("claude", now) ?? active("gemini", now); },
  };
}

/** 止める理由か（上限・請求・キー）。通信の失敗・混雑などは止めない */
export const BLOCKING_REASONS: ReadonlySet<string> = new Set(["spend_limit", "billing", "auth"]);
