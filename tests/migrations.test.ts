import assert from "node:assert/strict";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { runMigrations, schemaVersion, splitStatements } from "../src/server/store/migrate";
import { MIGRATIONS, type Migration } from "../src/server/store/migrations/index";
import { memoryDb } from "./helpers/sqlite";
import { createInstantApi } from "../src/server/instant/api";
import { createInstantStore, exportState } from "../src/server/instant/store";
import { cryptoRandomInt } from "../src/server/random";
import { makeFakeAi } from "./helpers/fake-ai";

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
  assert.ok(MIGRATIONS.length >= 3);
  const db = memoryDb();
  assert.deepEqual(runMigrations(db, [MIGRATIONS[0] as Migration], NOW), [1]);
  assert.deepEqual(runMigrations(db, MIGRATIONS.slice(0, 2), NOW + 1), [2]);
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

test("003：表と索引の形（users・trial_daily ができ、*_v2 は残らず、user_key が入る）", () => {
  const db = memoryDb();
  runMigrations(db, MIGRATIONS, NOW);
  const tables = names(db, "table");
  assert.ok(tables.includes("users") && tables.includes("trial_daily"));
  assert.deepEqual(tables.filter((n) => n.endsWith("_v2")), []);
  assert.deepEqual(columns(db, "users"), ["user_key", "display_name", "created_at", "last_seen_at"]);
  assert.deepEqual(columns(db, "trial_daily"), ["user_key", "day", "answers", "speech"]);
  assert.deepEqual(columns(db, "instant_meta"), ["user_key", "generation_id", "attempt_count", "created_at", "score_total"]);
  assert.deepEqual(columns(db, "instant_progress"), ["user_key", "question_id", "consecutive_passes", "cleared_at"]);
  assert.deepEqual(columns(db, "instant_settings"), ["user_key", "question_seconds", "question_count", "updated_at"]);
  assert.equal(columns(db, "instant_sessions").at(-1), "user_key");
  assert.equal(columns(db, "instant_attempts").at(-1), "user_key");
  assert.equal(columns(db, "instant_sessions").length, 10);
  assert.equal(columns(db, "instant_attempts").length, 22);
  const indexes = names(db, "index");
  assert.ok(indexes.includes("instant_sessions_user_active") && indexes.includes("instant_attempts_user") && indexes.includes("instant_attempts_user_created") && indexes.includes("instant_sessions_active"));
  // progress は (user_key, question_id) が主キー：同じ組は2回入らず、人が違えば入る
  const progress = "INSERT INTO instant_progress (user_key, question_id, consecutive_passes) VALUES (?, 'q001', 1)";
  db.run(progress, "alice");
  assert.throws(() => db.run(progress, "alice"));
  db.run(progress, "bob");
  db.run(progress, "");
  // meta は人ごとに1行
  const meta = "INSERT INTO instant_meta (user_key, generation_id, created_at) VALUES (?, 'g', 't')";
  db.run(meta, "alice");
  assert.throws(() => db.run(meta, "alice"));
  db.run(meta, "bob");
  // user_key に NULL は入れられない（SQLite は主キーでも NULL を許すので NOT NULL を明記している）
  assert.throws(() => db.run("INSERT INTO users (user_key, display_name, created_at, last_seen_at) VALUES (NULL, 'n', 't', 't')"));
  assert.throws(() => db.run("INSERT INTO instant_meta (user_key, generation_id, created_at) VALUES (NULL, 'g', 't')"));
  assert.throws(() => db.run("INSERT INTO instant_settings (user_key, question_seconds, question_count, updated_at) VALUES (NULL, '10', 10, 't')"));
  assert.throws(() => db.run("INSERT INTO instant_progress (user_key, question_id, consecutive_passes) VALUES (NULL, 'q001', 1)"));
  assert.throws(() => db.run("INSERT INTO trial_daily (user_key, day) VALUES (NULL, '2026-10-22')"));
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  db.close();
});

test("旧 DB（版2）の1人用の記録が、003 の後も1字も変わらない", async () => {
  const db = memoryDb();
  assert.deepEqual(runMigrations(db, MIGRATIONS.slice(0, 2), NOW), [1, 2]);
  const attemptSql = "INSERT INTO instant_attempts (id, session_id, question_id, created_at, outcome, recognition_status, transcript, meaning_score, grammar_score, score, passed, meaning_equivalent, reason_ja, grammar_feedback_ja, corrected_answer_en, natural_answer_en, model, rubric_version, transcription_model, consecutive_passes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const sessionSql = "INSERT INTO instant_sessions (id, generation_id, question_ids, answered_count, question_seconds, started_at, finished_at, ended_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  db.run("INSERT INTO instant_meta (id, generation_id, attempt_count, created_at) VALUES (1, 'gen-old', 6, '2026-10-01T00:00:00.000Z')");
  db.run(sessionSql, "s-1", "gen-old", JSON.stringify(["q001", "q002", "q003"]), 3, "15", "2026-10-01T01:00:00.000Z", "2026-10-01T01:10:00.000Z", "completed");
  db.run(sessionSql, "s-2", "gen-old", JSON.stringify(["q004", "q005", "q006"]), 2, "none", "2026-10-02T01:00:00.000Z", null, null);
  db.run(sessionSql, "s-3", "gen-old", JSON.stringify(["q007"]), 0, null, "2026-10-03T01:00:00.000Z", "2026-10-03T01:05:00.000Z", "stopped");
  db.run(attemptSql, "a1", "s-1", "q001", "2026-10-01T01:01:00.000Z", null, "clear", "I'm fine \ud83d\ude00", 70, 18, 88, 1, 1, "意味が伝わります。", "自然です。", "I am fine.", "I'm doing well.", "claude-x", "v1", "gemini-x", 1);
  db.run(attemptSql, "a2", "s-1", "q002", "2026-10-01T01:02:00.000Z", "no_answer", "no_speech", "", 0, 0, 0, 0, null, "時間内に回答がありませんでした。", "", null, null, null, "v1", null, 0);
  db.run(attemptSql, "a3", "s-1", "q003", "2026-10-01T01:03:00.000Z", null, "clear", "It's ok", 80, 20, 100, 1, 0, "r", "g", "", "", null, null, null, 3);
  db.run(attemptSql, "a4", "s-2", "q004", "2026-10-02T01:01:00.000Z", null, "clear", "hello", 10, 10, 20, 0, null, "r", "g", null, "Hello.", "m", "v1", "t", 0);
  db.run(attemptSql, "a5", "s-2", "q005", "2026-10-02T01:02:00.000Z", null, "clear", "world", 60, 15, 75, 0, 1, "r", "g", "World.", null, "m", "v1", null, 0);
  db.run(attemptSql, "a6", "s-3", "q007", "2026-10-03T01:02:00.000Z", null, "clear", "x", 50, 10, 60, 0, null, "r", "g", null, null, null, null, null, 0);
  db.run("INSERT INTO instant_progress (question_id, consecutive_passes, cleared_at) VALUES ('q001', 1, NULL), ('q003', 3, '2026-10-01T01:03:00.000Z')");
  db.run("INSERT INTO instant_settings (id, question_seconds, question_count, updated_at) VALUES (1, '20', 30, '2026-10-01T00:00:00.000Z')");
  db.run("INSERT INTO usage_days (day, model) VALUES ('2026-10-01', 'm1')");
  db.run("INSERT INTO usage_totals (model, calls, usd) VALUES ('m1', 4, 0.5)");
  db.run("INSERT INTO daily_counters (day, name, count) VALUES ('2026-10-01', 'answer', 6)");
  db.run("INSERT INTO login_failures (client_key, at_ms) VALUES ('1.2.3.4', 1)");
  db.run("INSERT INTO rate_hits (bucket, client_key, window_start_ms, count) VALUES ('answer', '1.2.3.4', 60000, 2)");
  const readOld = () => ({
    sessions: db.all("SELECT seq, id, generation_id, question_ids, answered_count, question_seconds, started_at, finished_at, ended_reason FROM instant_sessions ORDER BY seq"),
    attempts: db.all("SELECT seq, id, session_id, question_id, created_at, outcome, recognition_status, transcript, meaning_score, grammar_score, score, passed, meaning_equivalent, reason_ja, grammar_feedback_ja, corrected_answer_en, natural_answer_en, model, rubric_version, transcription_model, consecutive_passes FROM instant_attempts ORDER BY seq"),
    usageDays: db.all("SELECT * FROM usage_days ORDER BY day, model"),
    usageTotals: db.all("SELECT * FROM usage_totals ORDER BY model"),
    daily: db.all("SELECT * FROM daily_counters ORDER BY day, name"),
    failures: db.all("SELECT * FROM login_failures ORDER BY id"),
    rates: db.all("SELECT * FROM rate_hits ORDER BY bucket, client_key, window_start_ms"),
  });
  const before = JSON.parse(JSON.stringify(readOld()));
  const metaBefore = JSON.parse(JSON.stringify(db.all("SELECT generation_id, attempt_count, created_at FROM instant_meta")));
  const progressBefore = JSON.parse(JSON.stringify(db.all("SELECT question_id, consecutive_passes, cleared_at FROM instant_progress ORDER BY question_id")));
  const settingsBefore = JSON.parse(JSON.stringify(db.all("SELECT question_seconds, question_count, updated_at FROM instant_settings")));
  assert.deepEqual(runMigrations(db, MIGRATIONS, NOW + 1), [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(readOld())), before);
  assert.deepEqual(JSON.parse(JSON.stringify(db.all("SELECT generation_id, attempt_count, created_at FROM instant_meta"))), metaBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(db.all("SELECT question_id, consecutive_passes, cleared_at FROM instant_progress ORDER BY question_id"))), progressBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(db.all("SELECT question_seconds, question_count, updated_at FROM instant_settings"))), settingsBefore);
  for (const table of ["instant_meta", "instant_progress", "instant_settings", "instant_sessions", "instant_attempts"]) {
    assert.equal(db.all(`SELECT COUNT(*) AS n FROM ${table} WHERE user_key <> ''`)[0]?.n, 0, table);
    assert.ok(Number(db.all(`SELECT COUNT(*) AS n FROM ${table} WHERE user_key = ''`)[0]?.n) > 0, table);
  }
  // 合計の列は今ある回答の SUM(score) と一致し、件数と合わせた平均が出る（88+0+100+20+75+60=343、6件）
  assert.equal(Number(db.all("SELECT score_total FROM instant_meta WHERE user_key = ''")[0]?.score_total), 343);
  assert.equal(Number(db.all("SELECT SUM(score) AS t FROM instant_attempts")[0]?.t), 343);
  const solo = createInstantStore({ db, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, userKey: "" });
  assert.equal(solo.status().averageScore, 57.2);
  // exportState("") は入れた記録から組み立てた JSON と同じ
  const state = exportState(db, "");
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.generationId, "gen-old");
  assert.deepEqual(state.sessions, [
    { id: "s-1", generationId: "gen-old", questionIds: ["q001", "q002", "q003"], index: 3, startedAt: "2026-10-01T01:00:00.000Z", finishedAt: "2026-10-01T01:10:00.000Z", endedReason: "completed", questionSeconds: 15 },
    { id: "s-2", generationId: "gen-old", questionIds: ["q004", "q005", "q006"], index: 2, startedAt: "2026-10-02T01:00:00.000Z", finishedAt: null, endedReason: null },
    { id: "s-3", generationId: "gen-old", questionIds: ["q007"], index: 0, startedAt: "2026-10-03T01:00:00.000Z", finishedAt: "2026-10-03T01:05:00.000Z", endedReason: "stopped" },
  ]);
  assert.deepEqual(state.attempts.map((a) => a.id), ["a1", "a2", "a3", "a4", "a5", "a6"]);
  assert.deepEqual(state.attempts[0], { id: "a1", sessionId: "s-1", questionId: "q001", createdAt: "2026-10-01T01:01:00.000Z", recognitionStatus: "clear", transcript: "I'm fine \ud83d\ude00", meaningScore: 70, grammarScore: 18, score: 88, passed: true, meaningEquivalent: true, reasonJa: "意味が伝わります。", grammarFeedbackJa: "自然です。", correctedAnswerEn: "I am fine.", naturalAnswerEn: "I'm doing well.", model: "claude-x", rubricVersion: "v1", transcriptionModel: "gemini-x", consecutivePasses: 1 });
  assert.equal(state.attempts[1]?.outcome, "no_answer");
  assert.equal(state.attempts[2]?.correctedAnswerEn, "");
  assert.deepEqual(state.progress, { q001: { consecutivePasses: 1, clearedAt: null }, q003: { consecutivePasses: 3, clearedAt: "2026-10-01T01:03:00.000Z" } });
  // 1人用の API が003の後の DB で同じ値を返す
  const api = createInstantApi({ db, env: { GEMINI_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only" }, now: () => NOW, newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt, fetch: makeFakeAi().fetch });
  const settings = await api.request("/api/instant/settings");
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { questionSeconds: 20, questionCount: 30 });
  const status = await (await api.request("/api/instant/status")).json() as { generationId: string; attempts: number };
  assert.equal(status.generationId, "gen-old");
  assert.equal(status.attempts, 6);
  db.close();
});
