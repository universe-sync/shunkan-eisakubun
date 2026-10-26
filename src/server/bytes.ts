// Buffer を使わない、バイト列の小さな道具（Workers では Buffer に頼らない）
/** base64 → バイト列。呼ぶ前に正規表現 /^[A-Za-z0-9+/]+={0,2}$/ で形を確かめること */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** from〜to（to は含まない）を ASCII の文字列にする。範囲がバイト列より長ければ、あるところまで */
export function asciiAt(bytes: Uint8Array, from: number, to: number): string {
  let text = "";
  for (let i = from; i < to && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i] as number);
  return text;
}

/** バイト列 → base64url（= なし） */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** base64url → バイト列。形が正しくない・正規の書き方でない（戻して作り直した文字が元と違う）ときは null */
export function base64UrlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4)); } catch { return null; }
  return bytesToBase64Url(bytes) === text ? bytes : null;
}
