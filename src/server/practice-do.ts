import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import { outboundFetch } from "./ai/outbound";
import type { Env } from "./env";
import type { LoginDecision } from "./gate/limit";
import { createInstantApi } from "./instant/api";
import { cryptoRandomInt } from "./random";
import type { Db } from "./store/db";
import { doDb } from "./store/do-db";
import { loginAttempt } from "./store/login-failures";
import { runMigrations } from "./store/migrate";
import { MIGRATIONS } from "./store/migrations/index";

// API の処理は全部ここ（DO）で行う。Worker の CPU は 1 リクエスト 10ms だが、DO は 30 秒まで使える（Workers の上限）。
export class PracticeDO extends DurableObject<Env> {
  private readonly db: Db;
  private readonly api: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = doDb(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => { runMigrations(this.db, MIGRATIONS, Date.now()); });
    this.api = createInstantApi({
      db: this.db, env, now: () => Date.now(), newId: () => crypto.randomUUID(), randomInt: cryptoRandomInt,
      fetch: outboundFetch((url, init) => fetch(url, init)),
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.api.fetch(request);
  }

  /** RPC：合言葉の試み 1 回分を数える。合言葉そのものは受け取らない（合ったかどうかだけ）。同期の関数なので途中で割り込まれない */
  loginAttempt(key: string, ok: boolean): LoginDecision {
    return loginAttempt(this.db, key, ok, Date.now());
  }
}
