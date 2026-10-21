export const MAX_PASSWORD_LENGTH = 256;

/** 32 バイトなどの固定長を、途中で抜けずに比べる。長さが違えば偽 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.normalize("NFC")));
  return new Uint8Array(buf);
}

/** 合言葉の照合。どちらも NFC にして SHA-256 を取り、32 バイトどうしを時間一定で比べる */
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  if (input === "") return false;
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return equalBytes(a, b);
}
