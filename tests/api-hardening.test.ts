// 段1の検証で見つかった入力の穴（base64 の復号・generationId の型）の試験
import assert from "node:assert/strict";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { beginSession, makeApi } from "./helpers/api";
import { speechLike, toBase64, toWav } from "./helpers/wav-fixtures";

forbidNetwork();

test("形は正規表現に合うが atob が読めない base64 は、500 ではなく 400「録音データの形式が正しくありません。」", async () => {
  const a = makeApi();
  const s = await beginSession(a);
  for (const audioBase64 of ["A".repeat(1201), "A".repeat(1205), `${"A".repeat(1199)}A===`.slice(0, 1203)]) {
    const res = await a.postJson("/api/instant/answer", { sessionId: s.sessionId, questionId: s.ids[0], mimeType: "audio/wav", audioBase64 });
    assert.equal(res.status, 400, `長さ${audioBase64.length}`);
    assert.deepEqual(res.body, { error: "録音データの形式が正しくありません。" });
  }
  assert.equal(a.ai.geminiCalls.length, 0);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0]?.n, 0);
  // 読める base64 なら今までどおり（正しい WAV は200）
  const ok = await a.postJson("/api/instant/answer", { sessionId: s.sessionId, questionId: s.ids[0], mimeType: "audio/wav", audioBase64: toBase64(toWav(speechLike())), segmentEnd: "timeout" });
  assert.equal(ok.status, 200);
});

test("start：generationId が文字列以外でも、真なら文字にして比べる（12345・オブジェクト・true は 409）。偽・無しなら比べない", async () => {
  const a = makeApi();
  for (const bad of [12345, true, { a: 1 }, ["x"], 1]) {
    const res = await a.postJson("/api/instant/start", { generationId: bad });
    assert.equal(res.status, 409, JSON.stringify(bad));
    assert.equal(res.body.error, "記録がリセットされました。画面を更新してください。");
  }
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_sessions")[0]?.n, 0);
  // 偽の値（0・空文字・null）と、無いときは世代を比べない（元のアプリと同じ）
  for (const none of [0, "", null, undefined, false]) {
    const b = makeApi();
    const res = await b.postJson("/api/instant/start", none === undefined ? {} : { generationId: none });
    assert.equal(res.status, 200, String(none));
  }
  // 正しい世代なら通る
  const generationId = (await a.getJson("/api/instant/status")).body.generationId;
  assert.equal((await a.postJson("/api/instant/start", { generationId })).status, 200);
});
