export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
/** 1 回の呼び出しで 1 文だけ。値は ? の位置で渡す。BEGIN・COMMIT は流さない（transaction を使う） */
export interface Db {
  all(query: string, ...params: SqlValue[]): SqlRow[];
  run(query: string, ...params: SqlValue[]): void;
  transaction<T>(fn: () => T): T;
}
