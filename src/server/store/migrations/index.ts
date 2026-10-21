import { m001 } from "./001_init";
import { m002 } from "./002_guard";

export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
/** 版は 1 から 1 つずつ増やす。一度でも適用した版（.wrangler の手元の状態も含む）は書き換えない。直すときは新しい版を足す */
export const MIGRATIONS: readonly Migration[] = [m001, m002];
