// 外向きの fetch を許可リストで包む。「外へは Gemini・Anthropic だけ」をコードで守る
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const ALLOWED_PREFIXES = ["https://generativelanguage.googleapis.com/", "https://api.anthropic.com/"] as const;
const ALLOWED_ORIGINS = new Set(["https://generativelanguage.googleapis.com", "https://api.anthropic.com"]);

export const OUTBOUND_REFUSED_MESSAGE = "許可されていない送り先です";

function allowed(url: string): boolean {
  if (typeof url !== "string" || !ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.has(parsed.origin) && parsed.username === "" && parsed.password === "";
  } catch { return false; }
}

/** 許可しない送り先は、その場で例外を投げず、拒否された Promise で返す（呼び出し側の await / catch で扱える） */
export function outboundFetch(base: FetchLike): FetchLike {
  return (url, init) => {
    if (!allowed(url)) return Promise.reject(new Error(OUTBOUND_REFUSED_MESSAGE));
    return base(url, init);
  };
}
