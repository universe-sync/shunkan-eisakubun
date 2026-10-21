// DO の ctx.storage を Db に合わせる薄い包み（DO だけで使う。テストからは読まない）
import type { Db, SqlRow, SqlValue } from "./db";

export function doDb(storage: DurableObjectStorage): Db {
  const exec = (query: string, params: SqlValue[]): SqlRow[] => storage.sql.exec<SqlRow>(query, ...params).toArray();
  return {
    all(query: string, ...params: SqlValue[]): SqlRow[] {
      return exec(query, params);
    },
    run(query: string, ...params: SqlValue[]): void {
      exec(query, params);
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
