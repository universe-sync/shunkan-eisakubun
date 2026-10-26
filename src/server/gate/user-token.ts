import { base64UrlToBytes, bytesToBase64Url } from "../bytes";
import { isNameKey } from "../../shared/trial-rules.js";
import { equalBytes } from "./password";

// お試しモードの名前の cookie（app_user）。形 u1.<base64url(鍵)>.<発行時刻>.<hex64>。MAC は HMAC-SHA256(cookie 用の鍵, "app_user.v1." + 発行時刻 + "." + base64url)
export const USER_COOKIE = "app_user";
export const USER_MAX_AGE_SEC = 15552000;
export const USER_KEY_HEADER = "X-User-Key";
const USER_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SKEW_MS = 60_000;
const TOKEN_RE = /^u1\.([A-Za-z0-9_-]{1,400})\.(\d{1,16})\.([0-9a-f]{64})$/;
const enc = new TextEncoder();

async function mac(secret: string, issuedAt: string, b64: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`app_user.v1.${issuedAt}.${b64}`)));
}
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/** base64url → 名前の鍵。UTF-8 でない・正規でない・鍵の形でないときは null */
function decodeKeyText(b64: string): string | null {
  const bytes = base64UrlToBytes(b64);
  if (!bytes) return null;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  return isNameKey(text) ? text : null;
}

export const encodeUserKey = (key: string): string => bytesToBase64Url(enc.encode(key));
/** X-User-Key の値 → 名前の鍵（正しくなければ null） */
export function decodeUserKey(header: string | null | undefined): string | null {
  return typeof header === "string" ? decodeKeyText(header) : null;
}

export async function issueUserToken(secret: string, key: string, now: number): Promise<string> {
  const issuedAt = String(Math.floor(now));
  const b64 = encodeUserKey(key);
  return `u1.${b64}.${issuedAt}.${toHex(await mac(secret, issuedAt, b64))}`;
}

/** cookie の値 → 名前の鍵。署名・期限・鍵の形のどれかが正しくなければ null */
export async function verifyUserToken(secret: string, token: string | null | undefined, now: number): Promise<string | null> {
  if (typeof token !== "string") return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const [, b64, issuedAtText, sig] = m as unknown as [string, string, string, string];
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + SKEW_MS || now - issuedAt > USER_TTL_MS) return null;
  if (!equalBytes(await mac(secret, issuedAtText, b64), fromHex(sig))) return null;
  return decodeKeyText(b64);
}
