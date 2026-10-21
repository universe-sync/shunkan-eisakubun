import type { Db } from "../store/db";

// 戻り値は ok と（断ったときの）retryAfterSec。判別つきの共用体にしないのは、テスト用の tsconfig（strictNullChecks なし）でも同じ書き方で読めるようにするため
// IP ごとの頻度制限（1 分ごとの区切りで数える）。断った分は数えない。関数は同期
export interface RateResult { ok: boolean; retryAfterSec?: number }
export function hitRate(db: Db, bucket: string, key: string, perMinute: number, now: number): RateResult {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  return db.transaction(() => {
    db.run("DELETE FROM rate_hits WHERE window_start_ms < ?", now - 120_000);
    const row = db.all("SELECT count FROM rate_hits WHERE bucket = ? AND client_key = ? AND window_start_ms = ?", bucket, key, windowStart)[0];
    const used = row ? Number(row.count) : 0;
    if (used >= perMinute) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)) };
    db.run(
      "INSERT INTO rate_hits (bucket, client_key, window_start_ms, count) VALUES (?, ?, ?, 1) ON CONFLICT (bucket, client_key, window_start_ms) DO UPDATE SET count = count + 1",
      bucket, key, windowStart,
    );
    return { ok: true };
  });
}
