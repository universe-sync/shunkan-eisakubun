import type { Migration } from "./index";

// SQL の決まりは src/server/store/migrate.ts の冒頭と同じ（tests/migrations.test.ts が確かめる）。001・002 は手元の .wrangler/state に流れているので書き換えない
export const m003: Migration = {
  version: 3,
  name: "users",
  sql: `
-- お試しモード（複数人）の参加者。user_key は表示名の鍵（小文字・NFC・前後の空白なし）。1人用はこの表を使わない
CREATE TABLE users (
  user_key      TEXT NOT NULL PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- 世代と回答の件数・点数の合計を人ごとにする。1人用は user_key が空の文字。今までの id = 1 の行を空の文字の行へ移す
-- score_total は、その人の記録された回答すべての点数の合計（全体の平均＝score_total ÷ attempt_count。回答を全件読まずに済ませるため）。今ある回答から埋める
ALTER TABLE instant_meta RENAME TO instant_meta_v2;
CREATE TABLE instant_meta (
  user_key       TEXT NOT NULL PRIMARY KEY,
  generation_id  TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  score_total    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO instant_meta (user_key, generation_id, attempt_count, created_at, score_total)
SELECT '', generation_id, attempt_count, created_at, COALESCE((SELECT SUM(score) FROM instant_attempts), 0) FROM instant_meta_v2;
DROP TABLE instant_meta_v2;

-- 問題ごとの連続合格を人ごとにする
ALTER TABLE instant_progress RENAME TO instant_progress_v2;
CREATE TABLE instant_progress (
  user_key           TEXT NOT NULL,
  question_id        TEXT NOT NULL,
  consecutive_passes INTEGER NOT NULL,
  cleared_at         TEXT,
  PRIMARY KEY (user_key, question_id)
);
INSERT INTO instant_progress (user_key, question_id, consecutive_passes, cleared_at)
SELECT '', question_id, consecutive_passes, cleared_at FROM instant_progress_v2;
DROP TABLE instant_progress_v2;

-- 練習の設定を人ごとにする（記録のリセットでは消さない）
ALTER TABLE instant_settings RENAME TO instant_settings_v2;
CREATE TABLE instant_settings (
  user_key         TEXT NOT NULL PRIMARY KEY,
  question_seconds TEXT NOT NULL,
  question_count   INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
);
INSERT INTO instant_settings (user_key, question_seconds, question_count, updated_at)
SELECT '', question_seconds, question_count, updated_at FROM instant_settings_v2;
DROP TABLE instant_settings_v2;

-- 出題と回答に持ち主の列を足す（今までの行は空の文字＝1人用）
ALTER TABLE instant_sessions ADD COLUMN user_key TEXT NOT NULL DEFAULT '';
CREATE INDEX instant_sessions_user_active ON instant_sessions (user_key, seq) WHERE finished_at IS NULL;
ALTER TABLE instant_attempts ADD COLUMN user_key TEXT NOT NULL DEFAULT '';
CREATE INDEX instant_attempts_user ON instant_attempts (user_key, seq);
-- 今日の回答の数と平均（日本時間の今日の範囲）を、全件を読まずに数える。score も入れて、表を読まず索引だけで足せるようにする
CREATE INDEX instant_attempts_user_created ON instant_attempts (user_key, created_at, score);

-- お試しの1日の数（日本時間の日付）。answers は記録された回答、speech は読み上げで Gemini を呼んだ回数。記録のリセットでは消さない
CREATE TABLE trial_daily (
  user_key  TEXT NOT NULL,
  day       TEXT NOT NULL,
  answers   INTEGER NOT NULL DEFAULT 0,
  speech    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_key, day)
);
`,
};
