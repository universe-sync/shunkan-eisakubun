// 読み上げの音声を、このページを開いている間だけ覚えておく（同じ文をもう一度聞くとき API を呼ばない＝読み上げの回数を減らす）。
// 覚えるのは Blob（再生のたびに object URL を作り、終わったら消す）。ページを閉じる・読み込み直す・記録のリセットで消える
export const speechKey = (questionId: string, attemptId?: string): string => `${questionId}:${attemptId || "reference"}`;

export interface SpeechCache { get(key: string): Blob | undefined; set(key: string, blob: Blob): void; clear(): void; readonly size: number }
export function createSpeechCache(max = 30): SpeechCache {
  const map = new Map<string, Blob>();
  return {
    get(key) {
      const blob = map.get(key);
      if (blob === undefined) return undefined;
      map.delete(key); map.set(key, blob); // 使ったものを新しい側へ
      return blob;
    },
    set(key, blob) {
      map.delete(key); map.set(key, blob);
      while (map.size > max) { const oldest = map.keys().next().value as string; map.delete(oldest); }
    },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}
