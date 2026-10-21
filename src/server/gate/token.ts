import { equalBytes } from "./password";

export const GATE_COOKIE = "app_gate";
export const GATE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const GATE_MAX_AGE_SEC = 15552000;
export const CLOCK_SKEW_MS = 60_000;

const TOKEN_RE = /^v1\.(\d{1,16})\.([0-9a-f]{64})$/;
const enc = new TextEncoder();

let warnedShortSecret = false; // 1回だけ警告する（値は出さない）

/** 試験用：警告の「1回だけ」を戻す */
export function resetSecretWarning(): void { warnedShortSecret = false; }

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mac(cookieSecret: string, gatePassword: string, issuedAt: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(cookieSecret), enc.encode(`app_gate.v1.${issuedAt}.${gatePassword}`));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * cookie の署名に使う鍵。COOKIE_SECRET が32字以上ならそれ。
 * 無いか短ければ HMAC-SHA256(鍵＝NFC の合言葉, 文＝"app-gate-cookie-secret.v1") の hex（64字）。
 * 合言葉を変えると導いた鍵も署名する文も変わり、すべての cookie が使えなくなる。PBKDF2 は Workers の10ms に収まらないので使わない
 */
export async function resolveCookieSecret(env: { GATE_PASSWORD?: string; COOKIE_SECRET?: string }): Promise<string> {
  const given = env.COOKIE_SECRET;
  if (typeof given === "string" && given.length >= 32) return given;
  if (typeof given === "string" && given !== "" && !warnedShortSecret) { warnedShortSecret = true; console.warn("COOKIE_SECRET が32字未満のため使わず、合言葉から鍵を作ります"); }
  const password = (env.GATE_PASSWORD ?? "").trim().normalize("NFC");
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(password), enc.encode("app-gate-cookie-secret.v1"));
  return toHex(new Uint8Array(sig));
}

export async function issueToken(cookieSecret: string, gatePassword: string, now: number): Promise<string> {
  const issuedAt = String(Math.floor(now));
  return `v1.${issuedAt}.${toHex(await mac(cookieSecret, gatePassword, issuedAt))}`;
}

export async function verifyToken(cookieSecret: string, gatePassword: string, token: string | null | undefined, now: number): Promise<boolean> {
  if (typeof token !== "string") return false;
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const issuedAtText = m[1] as string;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt)) return false;
  if (issuedAt > now + CLOCK_SKEW_MS) return false;
  if (now - issuedAt > GATE_TTL_MS) return false;
  const expected = await mac(cookieSecret, gatePassword, issuedAtText);
  return equalBytes(expected, fromHex(m[2] as string));
}
