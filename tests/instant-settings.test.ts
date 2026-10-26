// 瞬間英作文の設定（src/server/instant/settings.ts）の試験。node:sqlite（:memory:）の上で行う
import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { createInstantSettings } from "../src/server/instant/settings";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
function fixture() { const db = migratedDb(NOW); return { db, settings: createInstantSettings(db, () => NOW, "") }; }
const quietWarn = async (work) => { const original = console.warn; console.warn = () => {}; try { return await work(); } finally { console.warn = original; } };

test("行が無ければ既定（1問10秒・10問）で、行は作らない", async () => {
  const { db, settings } = fixture();
  assert.deepEqual(await settings.get(), { questionSeconds: 10, questionCount: 10 });
  assert.equal(db.all("SELECT * FROM instant_settings").length, 0);
});

test("保存して読み戻せる（別のインスタンスでも）。", async () => {
  const { db, settings } = fixture();
  assert.deepEqual(await settings.set({ questionSeconds: 20, questionCount: 50 }), { questionSeconds: 20, questionCount: 50 });
  assert.deepEqual(await settings.get(), { questionSeconds: 20, questionCount: 50 });
  assert.deepEqual(await createInstantSettings(db, () => NOW, "").get(), { questionSeconds: 20, questionCount: 50 });
  assert.equal(db.all("SELECT * FROM instant_settings").length, 1); // 行は1つだけ
});

test("正しくない値は400で拒否し、前の値のまま", async () => {
  const { settings } = fixture();
  await settings.set({ questionSeconds: 15, questionCount: 20 });
  const bads = [{ questionSeconds: 9, questionCount: 10 }, { questionSeconds: 31, questionCount: 10 }, { questionSeconds: "15", questionCount: 10 }, { questionSeconds: "none", questionCount: 10 }, { questionSeconds: null, questionCount: 10 }, { questionSeconds: 12.5, questionCount: 10 }, { questionSeconds: 15, questionCount: 15 }, { questionSeconds: 15 }, {}, null];
  for (const bad of bads) assert.throws(() => settings.set(bad), { status: 400 });
  assert.deepEqual(await settings.get(), { questionSeconds: 15, questionCount: 20 });
});

test("前の版が保存した 'none'（制限なし）は10秒として読み、問題数は生かす。エラーにしない", async () => {
  const { db, settings } = fixture();
  db.run("INSERT INTO instant_settings (user_key, question_seconds, question_count, updated_at) VALUES ('', 'none', 30, 'x')");
  assert.deepEqual(await quietWarn(() => settings.get()), { questionSeconds: 10, questionCount: 30 });
  await settings.set({ questionSeconds: 15, questionCount: 30 });
  assert.deepEqual(await settings.get(), { questionSeconds: 15, questionCount: 30 });
});

test("SQL で直に書いた不正な値は、その項目だけ既定にして警告だけ。次の保存で直る", async () => {
  const { db, settings } = fixture();
  db.run("INSERT INTO instant_settings (user_key, question_seconds, question_count, updated_at) VALUES ('', 'abc', 20, 'x')");
  assert.deepEqual(await quietWarn(() => settings.get()), { questionSeconds: 10, questionCount: 20 });
  db.run("UPDATE instant_settings SET question_seconds = '20', question_count = 15");
  assert.deepEqual(await quietWarn(() => settings.get()), { questionSeconds: 20, questionCount: 10 });
  db.run("UPDATE instant_settings SET question_seconds = '45', question_count = 15");
  assert.deepEqual(await quietWarn(() => settings.get()), { questionSeconds: 10, questionCount: 10 });
  const warnings: unknown[][] = [];
  const original = console.warn; console.warn = (...args) => warnings.push(args);
  try { settings.get(); } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  await settings.set({ questionSeconds: 15, questionCount: 20 });
  assert.deepEqual(await settings.get(), { questionSeconds: 15, questionCount: 20 });
});

test("alice の保存は bob と 1人用（''）に影響しない", async () => {
  const db = migratedDb(NOW);
  const alice = createInstantSettings(db, () => NOW, "alice"), bob = createInstantSettings(db, () => NOW, "bob"), solo = createInstantSettings(db, () => NOW, "");
  alice.set({ questionSeconds: 25, questionCount: 50 });
  assert.deepEqual(alice.get(), { questionSeconds: 25, questionCount: 50 });
  assert.deepEqual(bob.get(), { questionSeconds: 10, questionCount: 10 });
  assert.deepEqual(solo.get(), { questionSeconds: 10, questionCount: 10 });
  solo.set({ questionSeconds: 12, questionCount: 20 });
  bob.set({ questionSeconds: 30, questionCount: 30 });
  assert.deepEqual(alice.get(), { questionSeconds: 25, questionCount: 50 });
  assert.deepEqual(solo.get(), { questionSeconds: 12, questionCount: 20 });
  assert.deepEqual(db.all("SELECT user_key FROM instant_settings ORDER BY user_key").map((r) => r.user_key), ["", "alice", "bob"]);
});
