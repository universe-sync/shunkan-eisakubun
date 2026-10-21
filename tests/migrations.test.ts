import assert from "node:assert/strict";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { runMigrations, schemaVersion, splitStatements } from "../src/server/store/migrate";
import { MIGRATIONS, type Migration } from "../src/server/store/migrations/index";
import { memoryDb } from "./helpers/sqlite";

forbidNetwork();
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);

test("MIGRATIONS の版は 1 から並ぶ", () => {
  MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1));
});

test("SQL の決まり：`;` は行末だけ、使えない語を書かない、`\"` を書かない", () => {
  for (const m of MIGRATIONS) {
    for (const line of m.sql.split("\n")) {
      const t = line.trimEnd();
      const semis = (t.match(/;/g) ?? []).length;
      if (semis > 0) {
        assert.equal(semis, 1, `${m.name}: ${t}`);
        assert.ok(t.endsWith(";"), `${m.name}: ; は行末にだけ: ${t}`);
        assert.ok(!t.trimStart().startsWith("--"), `${m.name}: コメントに ; がある: ${t}`);
      }
    }
    assert.ok(!m.sql.includes('"'), `${m.name}: " がある`);
    assert.ok(!/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA|ATTACH|TRIGGER)\b/i.test(m.sql.replace(/^--.*$/gm, "")), `${m.name}: 使えない語`);
  }
});

test("splitStatements：コメントだけの塊を捨てる／最後に ; が無ければ例外", () => {
  assert.deepEqual(splitStatements("-- c\nSELECT 1;\n\n-- d\nSELECT 2;\n"), ["-- c\nSELECT 1", "-- d\nSELECT 2"]);
  assert.deepEqual(splitStatements("-- コメントだけ\n"), []);
  assert.deepEqual(splitStatements("SELECT 1;\n-- 末尾のコメント\n"), ["SELECT 1"]);
  assert.throws(() => splitStatements("SELECT 1;\nSELECT 2"));
});

function names(db: ReturnType<typeof memoryDb>, type: "table" | "index"): string[] {
  return db.all("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type).map((r) => String(r.name));
}
function columns(db: ReturnType<typeof memoryDb>, table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).map((r) => String(r.name));
}

test("001 を流すと表と索引ができ、列がこのアプリの記録の形と一致する", () => {
  const db = memoryDb();
  runMigrations(db, [MIGRATIONS[0] as Migration], NOW);
  assert.deepEqual(names(db, "table"), ["instant_attempts", "instant_meta", "instant_progress", "instant_sessions", "instant_settings", "schema_migrations", "usage_days", "usage_totals"]);
  assert.deepEqual(names(db, "index").filter((n) => !n.startsWith("sqlite_autoindex")), ["instant_sessions_active"]);
  assert.deepEqual(columns(db, "instant_meta"), ["id", "generation_id", "attempt_count", "created_at"]);
  assert.deepEqual(columns(db, "instant_sessions"), ["seq", "id", "generation_id", "question_ids", "answered_count", "question_seconds", "started_at", "finished_at", "ended_reason"]);
  assert.deepEqual(columns(db, "instant_attempts"), ["seq", "id", "session_id", "question_id", "created_at", "outcome", "recognition_status", "transcript", "meaning_score", "grammar_score", "score", "passed", "meaning_equivalent", "reason_ja", "grammar_feedback_ja", "corrected_answer_en", "natural_answer_en", "model", "rubric_version", "transcription_model", "consecutive_passes"]);
  assert.deepEqual(columns(db, "instant_progress"), ["question_id", "consecutive_passes", "cleared_at"]);
  assert.deepEqual(columns(db, "instant_settings"), ["id", "question_seconds", "question_count", "updated_at"]);
  assert.deepEqual(columns(db, "usage_days"), ["day", "model", "calls", "missing_usage_calls", "unpriced_calls", "input_tokens", "audio_input_tokens", "cached_tokens", "cache_write_tokens", "cache_write_1h_tokens", "output_tokens", "thought_tokens", "tool_use_tokens", "usd"]);
  assert.deepEqual(columns(db, "usage_totals"), ["model", "calls", "missing_usage_calls", "unpriced_calls", "usd"]);
  assert.equal(schemaVersion(db), 1);
  assert.equal(db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0]?.n, 0);
  // meta・settings は1行だけ（id = 1 の CHECK）
  assert.throws(() => db.run("INSERT INTO instant_meta (id, generation_id, created_at) VALUES (2, 'x', 'y')"));
  // 同じ出題の同じ問題は2回記録できない（UNIQUE）
  const attempt = "INSERT INTO instant_attempts (id, session_id, question_id, created_at, recognition_status, transcript, meaning_score, grammar_score, score, passed, reason_ja, grammar_feedback_ja, consecutive_passes) VALUES (?, 's', 'q001', 't', 'clear', 'x', 1, 1, 2, 0, 'r', 'g', 0)";
  db.run(attempt, "a1");
  assert.throws(() => db.run(attempt, "a2"));
  db.close();
});

test("002 は 001 の後に流れ、合言葉の失敗・1日の回数・頻度の表ができる。001 の表は変わらない", () => {
  assert.equal(MIGRATIONS.length, 2);
  const db = memoryDb();
  assert.deepEqual(runMigrations(db, [MIGRATIONS[0] as Migration], NOW), [1]);
  assert.deepEqual(runMigrations(db, MIGRATIONS, NOW + 1), [2]);
  assert.deepEqual(names(db, "table").filter((n) => ["login_failures", "daily_counters", "rate_hits"].includes(n)), ["daily_counters", "login_failures", "rate_hits"]);
  assert.deepEqual(columns(db, "login_failures"), ["id", "client_key", "at_ms"]);
  assert.deepEqual(columns(db, "daily_counters"), ["day", "name", "count"]);
  assert.deepEqual(columns(db, "rate_hits"), ["bucket", "client_key", "window_start_ms", "count"]);
  assert.ok(names(db, "index").includes("login_failures_at"));
  assert.deepEqual(columns(db, "instant_meta"), ["id", "generation_id", "attempt_count", "created_at"]); // 001 のまま
  assert.equal(schemaVersion(db), 2);
  db.run("INSERT INTO daily_counters (day, name, count) VALUES ('2026-10-21', 'answer', 1)");
  assert.throws(() => db.run("INSERT INTO daily_counters (day, name, count) VALUES ('2026-10-21', 'answer', 1)")); // 主キー
  db.close();
});

test("2回流しても何も起きず、適用した版の一覧は空", () => {
  const db = memoryDb();
  assert.deepEqual(runMigrations(db, MIGRATIONS, NOW), MIGRATIONS.map((m) => m.version));
  assert.deepEqual(runMigrations(db, MIGRATIONS, NOW + 1000), []);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  db.close();
});

test("プログラムより新しい版のデータベースは開けず、版が1から並んでいなければ例外", () => {
  const db = memoryDb();
  runMigrations(db, MIGRATIONS, NOW);
  db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", MIGRATIONS.length + 1, "2026-10-21T00:00:00Z");
  assert.throws(() => runMigrations(db, MIGRATIONS, NOW), /より新しいため開けません/);
  assert.throws(() => runMigrations(memoryDb(), [{ version: 2, name: "x", sql: "SELECT 1;" }], NOW), /1 から順に並んでいません/);
  db.close();
});
