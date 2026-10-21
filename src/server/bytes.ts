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
