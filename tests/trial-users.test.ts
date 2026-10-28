import assert from "node:assert/strict";
import { test } from "node:test";
import { trialConfig } from "../src/server/trial/config";
import { findUser, registerUser } from "../src/server/trial/users";
import { migratedDb } from "./helpers/sqlite";

const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);
const cfg = trialConfig({ TRIAL_MODE: "1", TRIAL_ENDS_ON: "2026-10-30" });
const TAKEN = "その名前はすでに登録されています。あなたの名前なら、引き継ぎ番号（6桁）を入れてください。ほかの人の名前なら、別の名前にしてください。";

test("新しい名前は ok で、users に1行入る", () => {
  const db = migratedDb(NOW);
  const r = registerUser(db, cfg, "Mika", null, NOW);
  assert.deepEqual(r, { ok: true, key: "mika", displayName: "Mika" });
  assert.deepEqual(findUser(db, "mika"), { key: "mika", displayName: "Mika" });
  assert.equal(findUser(db, "nobody"), null);
});

test("大文字小文字・空白違いは name_taken で、表示名は最初の形のまま", () => {
  const db = migratedDb(NOW);
  registerUser(db, cfg, "Mika", null, NOW);
  const r = registerUser(db, cfg, " MIKA ", null, NOW + 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "name_taken");
  assert.equal(r.message, TAKEN);
  assert.equal(findUser(db, "mika")?.displayName, "Mika");
  assert.equal(registerUser(db, cfg, "Mika", "alice", NOW).reason, "name_taken"); // 別の人の cookie
});

test("同じ鍵で currentKey が同じなら ok（二度押し）で、表示名はそのまま・last_seen_at だけ更新", () => {
  const db = migratedDb(NOW);
  registerUser(db, cfg, "Mika", null, NOW);
  const again = registerUser(db, cfg, "MIKA", "mika", NOW + 5000);
  assert.deepEqual(again, { ok: true, key: "mika", displayName: "Mika" });
  const row = db.all("SELECT created_at, last_seen_at FROM users")[0];
  assert.equal(row?.created_at, new Date(NOW).toISOString());
  assert.equal(row?.last_seen_at, new Date(NOW + 5000).toISOString());
  assert.equal(db.all("SELECT * FROM users").length, 1);
});

test("だめな名前は bad_name、終了日の翌日は trial_closed、無効は trial_off（どれも users は増えない）", () => {
  const db = migratedDb(NOW);
  assert.equal(registerUser(db, cfg, "   ", null, NOW).reason, "bad_name");
  assert.equal(registerUser(db, cfg, "あ".repeat(21), null, NOW).reason, "bad_name");
  assert.equal(registerUser(db, cfg, 5, null, NOW).reason, "bad_name");
  assert.equal(registerUser(db, cfg, "ok", null, Date.UTC(2026, 9, 30, 15, 0, 0)).reason, "trial_closed");
  assert.equal(registerUser(db, cfg, "ok", null, Date.UTC(2026, 9, 30, 14, 59, 59)).ok, true);
  assert.equal(registerUser(db, trialConfig({}), "ok2", null, NOW).reason, "trial_off");
  assert.equal(db.all("SELECT * FROM users").length, 1);
});

test("同じ名前を2回続けて登録すると、2回目は name_taken", () => {
  const db = migratedDb(NOW);
  assert.equal(registerUser(db, cfg, "Same", null, NOW).ok, true);
  assert.equal(registerUser(db, cfg, "Same", null, NOW).reason, "name_taken");
});

test("resume（引き継ぎ番号が合った）なら別の currentKey でも ok。表示名はそのまま・last_seen_at だけ更新。resume なしは name_taken", () => {
  const db = migratedDb(NOW);
  registerUser(db, cfg, "Mika", null, NOW);
  const created = String(db.all("SELECT created_at FROM users WHERE user_key = 'mika'")[0]?.created_at);
  const r = registerUser(db, cfg, " MIKA ", null, NOW + 60_000, true);
  assert.deepEqual(r, { ok: true, key: "mika", displayName: "Mika" });
  const row = db.all("SELECT display_name, created_at, last_seen_at FROM users WHERE user_key = 'mika'")[0];
  assert.equal(row?.display_name, "Mika");
  assert.equal(row?.created_at, created);
  assert.notEqual(row?.last_seen_at, created);
  assert.equal(registerUser(db, cfg, "Mika", "alice", NOW, true).ok, true);
  assert.equal(registerUser(db, cfg, "Mika", "alice", NOW, false).reason, "name_taken");
  // 未登録の名前は resume でも新しく作る（Worker 側で番号が合わなければ、ここへ来ない）
  assert.equal(registerUser(db, cfg, "Newbie", null, NOW, true).ok, true);
});
