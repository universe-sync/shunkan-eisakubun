import type { Context } from "hono";

export class HttpError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.reason = reason;
  }
}

/** 本文を少しずつ読み、maxBytes を超えたら読むのをやめて null を返す */
export async function readLimitedText(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** JSON のオブジェクトを読む。空なら {}。超えたら 413、JSON でないかオブジェクトでなければ 400 */
export async function readJsonObject(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await readLimitedText(c.req.raw, maxBytes);
  if (text === null) throw new HttpError(413, "送られたデータが大きすぎます。", "too_large");
  if (text.trim() === "") return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "送られたデータの形式が正しくありません。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "送られたデータの形式が正しくありません。");
  return value as Record<string, unknown>;
}
