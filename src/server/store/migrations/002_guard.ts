import type { Migration } from "./index";

// SQL の決まりは src/server/store/migrate.ts の冒頭と同じ（tests/migrations.test.ts が確かめる）。001 は手元の .wrangler/state に流れているので書き換えない
export const m002: Migration = {
  version: 2,
  name: "guard",
  sql: `
-- 合言葉の失敗。client_key は CF-Connecting-IP（無ければ local）、at_ms は失敗の時刻（epoch ms）。10 分より古い行は次の試みのときに消す
CREATE TABLE login_failures (
  id          INTEGER PRIMARY KEY,
  client_key  TEXT NOT NULL,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX login_failures_at ON login_failures (at_ms);

-- 1 日の回数（日本時間の日付）。name は answer か speech
CREATE TABLE daily_counters (
  day   TEXT NOT NULL,
  name  TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);

-- IP ごとの頻度（1 分の区切り）。bucket は answer か speech
CREATE TABLE rate_hits (
  bucket          TEXT NOT NULL,
  client_key      TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  PRIMARY KEY (bucket, client_key, window_start_ms)
);
`,
};
