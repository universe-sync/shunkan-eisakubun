import { MAX_PASSWORD_LENGTH } from "./password";

/** 合言葉の最小の長さ（コードポイントで数える）。短い合言葉では門が開かない */
export const MIN_PASSWORD_CHARS = 10;

/** 設定が足りているか。GATE_PASSWORD が前後の空白を除いて10字以上（COOKIE_SECRET は見ない。無ければ合言葉から導く） */
export function isConfigured(env: { GATE_PASSWORD?: string }): boolean {
  const pw = env.GATE_PASSWORD;
  if (typeof pw !== "string") return false;
  const t = pw.trim();
  // 下限はコードポイント、上限は UTF-16（ログイン側の MAX_PASSWORD_LENGTH と同じ数え方）。上限を超えるとログインできないので門も閉じる
  return [...t].length >= MIN_PASSWORD_CHARS && t.length <= MAX_PASSWORD_LENGTH;
}

/** 照合・署名に使う合言葉。secret の前後の空白（貼り付けの改行など）は除く */
export function gatePassword(env: { GATE_PASSWORD?: string }): string {
  return (env.GATE_PASSWORD ?? "").trim();
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Secure を付けるか。http でホストがループバックのときだけ付けない（本番は必ず付く） */
export function cookieSecure(url: URL): boolean {
  return !(url.protocol === "http:" && isLoopbackHost(url.hostname));
}

/** 失敗回数・頻度の数え分けに使う印。CF-Connecting-IP（1〜64 字）。無いか長すぎれば local */
export function clientKey(req: Request): string {
  const v = req.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return v.length >= 1 && v.length <= 64 ? v : "local";
}

/** 門の外に置くアイコン（public から dist/client の直下に出る）。決めた名前だけ */
export const ICON_PATHS = ["/icon.svg", "/icon-32.png", "/apple-touch-icon.png"] as const;

/**
 * 門の外のパス（拒否が既定）。生のパス（デコードしない）で判定する。
 * 決まり：門の外のパスが届く先は、ASSETS とログイン・ログアウトの処理だけ。DO へ渡すのは、門を通った /api/* だけ
 */
export function gateExempt(method: string, pathname: string): boolean {
  const safe = method === "GET" || method === "HEAD";
  if (safe && pathname === "/login") return true;
  if (method === "POST" && (pathname === "/login" || pathname === "/logout")) return true;
  if (safe && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname) && !pathname.includes("..")) return true;
  if (safe && (ICON_PATHS as readonly string[]).includes(pathname)) return true;
  return false;
}
