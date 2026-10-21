// マイグレーションを流す。DO の SQLite でも node:sqlite でも動くよう、Db の型だけに頼る。
//
// マイグレーションの SQL の決まり（tests/migrations.test.ts が確かめる）：
// - `;` は文の終わりの行末にだけ書く。`;` の後ろに何も書かない（コメントは前の行に書く）
// - それ以外の場所（コメント・文字列の中）に `;` を書かない
// - BEGIN・COMMIT・ROLLBACK・SAVEPOINT・PRAGMA・ATTACH・TRIGGER を書かない
// - 文字列は単引用符。`"` を書かない（コメントにも）
import type { Db } from "./db";
import type { Migration } from "./migrations/index";
import { isoSeconds } from "../time";

/** 1 行ずつ読み、行末（後ろの空白は除く）が `;` の行で文を区切る。コメントだけの塊は捨てる */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const body = cur.join("\n").trim();
    cur = [];
    if (body === "") return;
    const hasCode = body.split("\n").some((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("--");
    });
    if (hasCode) out.push(body);
  };
  for (const line of sql.split("\n")) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.endsWith(";") && !trimmed.trimStart().startsWith("--")) {
      cur.push(trimmed.slice(0, -1));
      flush();
    } else {
      cur.push(line);
    }
  }
  // 最後に `;` で終わらない文が残っていたら例外にする（コメントだけなら捨てる）
  const rest = cur.join("\n").trim();
  if (rest !== "") {
    const hasCode = rest.split("\n").some((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("--");
    });
    if (hasCode) throw new Error("マイグレーションの SQL の最後が `;` で終わっていません。");
  }
  return out;
}

export function schemaVersion(db: Db): number {
  const rows = db.all("SELECT MAX(version) AS v FROM schema_migrations");
  const v = rows[0]?.v;
  return typeof v === "number" ? v : 0;
}

/** まだの版を流す。適用した版の一覧を返す */
export function runMigrations(db: Db, migrations: readonly Migration[], now: number): number[] {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`マイグレーションの版が 1 から順に並んでいません（${m.version}）。`);
  });
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`データベースの版（${current}）が、このプログラムの版（${migrations.length}）より新しいため開けません。`);
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    try {
      db.transaction(() => {
        for (const stmt of splitStatements(m.sql)) db.run(stmt);
        db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", m.version, isoSeconds(now));
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "原因不明";
      throw new Error(`マイグレーション ${m.version}（${m.name}）に失敗しました：${reason}`);
    }
    applied.push(m.version);
  }
  return applied;
}
