import type { Db } from "./db";
import { decideLogin, LOGIN_RULE, type LoginDecision, type LoginRule } from "../gate/limit";

// 同期の関数。数えてから記録するまでの間に await を挟まない（DO は同期のコードの途中に別の要求を割り込ませない）
export function loginAttempt(db: Db, key: string, ok: boolean, now: number, rule: LoginRule = LOGIN_RULE, clearOnOk = true): LoginDecision {
  return db.transaction(() => {
    db.run("DELETE FROM login_failures WHERE at_ms <= ?", now - rule.windowMs);
    const rows = db.all("SELECT client_key, at_ms FROM login_failures WHERE at_ms > ?", now - rule.windowMs);
    const all = rows.map((r) => Number(r.at_ms));
    const mine = rows.filter((r) => r.client_key === key).map((r) => Number(r.at_ms));
    const d = decideLogin({ ok, mine, all, now, rule });
    if (d.result === "ok") { if (clearOnOk) db.run("DELETE FROM login_failures WHERE client_key = ?", key); }
    else if (d.result === "wrong") db.run("INSERT INTO login_failures (client_key, at_ms) VALUES (?, ?)", key, now);
    return d;   // limited のときは記録しない（止まっている間の試みで、止まる時間を延ばさない）
  });
}
