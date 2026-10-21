import type { Migration } from "./index";

// SQL の決まりは src/server/store/migrate.ts の冒頭と同じ（tests/migrations.test.ts が確かめる）
export const m001: Migration = {
  version: 1,
  name: "init",
  sql: `
-- 瞬間英作文の世代（記録をリセットするたびに変わる ID）と、回答の件数。1 行だけ（id は 1）
CREATE TABLE instant_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  generation_id  TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- 出題。question_ids は問題の ID の JSON の配列（出題の順）。seq は記録の順（元の sessions の配列の順）
-- question_seconds は 10 から 30 の数字の文字か none。記録しないときは NULL
-- answered_count は元の index（答えが記録された数）。ended_reason は completed か stopped で、古い記録は NULL（completed とみなす）
CREATE TABLE instant_sessions (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  generation_id    TEXT NOT NULL,
  question_ids     TEXT NOT NULL,
  answered_count   INTEGER NOT NULL DEFAULT 0,
  question_seconds TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  ended_reason     TEXT
);
CREATE INDEX instant_sessions_active ON instant_sessions (seq) WHERE finished_at IS NULL;

-- 回答。outcome は no_answer（回答なし）か NULL（ふつうの回答）。passed は 0 か 1
-- meaning_equivalent・corrected_answer_en・natural_answer_en・transcription_model は、項目が無いとき NULL。音声は保存しない
CREATE TABLE instant_attempts (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  session_id          TEXT NOT NULL,
  question_id         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  outcome             TEXT,
  recognition_status  TEXT NOT NULL,
  transcript          TEXT NOT NULL,
  meaning_score       INTEGER NOT NULL,
  grammar_score       INTEGER NOT NULL,
  score               INTEGER NOT NULL,
  passed              INTEGER NOT NULL,
  meaning_equivalent  INTEGER,
  reason_ja           TEXT NOT NULL,
  grammar_feedback_ja TEXT NOT NULL,
  corrected_answer_en TEXT,
  natural_answer_en   TEXT,
  model               TEXT,
  rubric_version      TEXT,
  transcription_model TEXT,
  consecutive_passes  INTEGER NOT NULL,
  UNIQUE (session_id, question_id)
);

-- 問題ごとの連続合格（0 から 3）。3 でクリア
CREATE TABLE instant_progress (
  question_id        TEXT PRIMARY KEY,
  consecutive_passes INTEGER NOT NULL,
  cleared_at         TEXT
);

-- 練習の設定（1 行だけ）。記録のリセットでは消さない。question_seconds は 10 から 30 の数字の文字か none
CREATE TABLE instant_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  question_seconds TEXT NOT NULL,
  question_count   INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 利用料の目安。日本時間の日ごと、モデルごと。音声と文字は保存しない
CREATE TABLE usage_days (
  day                   TEXT NOT NULL,
  model                 TEXT NOT NULL,
  calls                 INTEGER NOT NULL DEFAULT 0,
  missing_usage_calls   INTEGER NOT NULL DEFAULT 0,
  unpriced_calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  audio_input_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  thought_tokens        INTEGER NOT NULL DEFAULT 0,
  tool_use_tokens       INTEGER NOT NULL DEFAULT 0,
  usd                   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

-- 利用料の累計（モデルごと）。summary が全部の日を読まずに済むよう、記録のたびに足す
CREATE TABLE usage_totals (
  model               TEXT PRIMARY KEY,
  calls               INTEGER NOT NULL DEFAULT 0,
  missing_usage_calls INTEGER NOT NULL DEFAULT 0,
  unpriced_calls      INTEGER NOT NULL DEFAULT 0,
  usd                 REAL NOT NULL DEFAULT 0
);
`,
};
