// DO の SQLite の代わりに node:sqlite（:memory:）で Db を作る
import { DatabaseSync } from "node:sqlite";
import type { Db, SqlRow, SqlValue } from "../../src/server/store/db";
import { runMigrations } from "../../src/server/store/migrate";
import { MIGRATIONS } from "../../src/server/store/migrations/index";

export function memoryDb(): Db & { close(): void; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return {
    raw,
    all(query: string, ...params: SqlValue[]): SqlRow[] {
      return raw.prepare(query).all(...params) as unknown as SqlRow[];
    },
    run(query: string, ...params: SqlValue[]): void {
      raw.prepare(query).run(...params);
    },
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    close(): void { raw.close(); },
  };
}

/** 全部のマイグレーションまで流したもの */
export function migratedDb(now: number): ReturnType<typeof memoryDb> {
  const db = memoryDb();
  runMigrations(db, MIGRATIONS, now);
  return db;
}
