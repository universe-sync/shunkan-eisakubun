/** 0 以上 maxExclusive 未満の整数を、偏りが出ないよう棄却しながら選ぶ（node:crypto の randomInt の代わり） */
export function cryptoRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) throw new RangeError("maxExclusive は 1 から 2**32 の整数です。");
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < limit) return v % maxExclusive;
  }
}
