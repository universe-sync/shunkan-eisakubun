// 外部 API の上限・残高切れの見分けと、10分の一時停止
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeError, createClaude, regainJst } from "../src/server/ai/claude";
import { createGemini, GeminiError } from "../src/server/ai/gemini";
import { instantQuestions } from "../src/server/instant/questions";
import { createProviderBlocker, PROVIDER_BLOCK_MS } from "../src/server/guard/provider-block";
import { forbidNetwork } from "./helpers/no-network";
import { beginSession, makeApi } from "./helpers/api";
import { makeFakeAi, type Failure } from "./helpers/fake-ai";
import { speechLike, toBase64, toWav } from "./helpers/wav-fixtures";

forbidNetwork();

const voiced = () => toBase64(toWav(speechLike()));
const body = (s: { sessionId: string; ids: string[] }, i: number) => ({ sessionId: s.sessionId, questionId: s.ids[i], mimeType: "audio/wav", audioBase64: voiced(), segmentEnd: "timeout" });
const claudeBody = (type: string, message: string, extra: Record<string, unknown> = {}) => ({ status: 400, body: { type: "error", error: { type, message, ...extra } } });
const WORKSPACE = "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const quietWarn = async <T>(fn: () => Promise<T>): Promise<T> => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

const question = instantQuestions[0]!;
const claudeWith = (failures: Failure[]) => {
  const ai = makeFakeAi();
  ai.claudeFailures.push(...failures);
  return createClaude({ apiKey: () => "test-only", fetch: ai.fetch });
};
const geminiWith = (failures: Failure[]) => {
  const ai = makeFakeAi();
  ai.geminiFailures.push(...failures);
  return { ai, gemini: createGemini({ apiKey: () => "test-only", fetch: ai.fetch, wait: async () => {} }) };
};
const transcribe = (g: ReturnType<typeof createGemini>) => g.transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });

test("regainJst：UTC の戻る時刻を日本時間（+9時間）にする", () => {
  assert.equal(regainJst(WORKSPACE), "（日本時間 11月1日 9時に戻ります）");
  assert.equal(regainJst("regain access on 2026-12-31 at 20:30 UTC"), "（日本時間 1月1日 5時30分に戻ります）"); // 年・月をまたぐ
  assert.equal(regainJst("no date here"), "");
  assert.equal(regainJst(""), "");
});

test("Claude 400（workspace の自分の上限）→ spend_limit・月の上限・戻る日の日本時間。再送しない", async () => {
  const claude = claudeWith([claudeBody("invalid_request_error", WORKSPACE)]);
  await assert.rejects(claude.gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "spend_limit" && e.status === 503
    && e.message === "Claude の月の上限（Claude Console で決めた支出の上限）に達しました。上限を上げるか、上限が戻るまで採点できません。（日本時間 11月1日 9時に戻ります）");
  const noWorkspace = claudeWith([claudeBody("invalid_request_error", "You have reached your specified API usage limits.")]);
  await assert.rejects(noWorkspace.gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "spend_limit" && !e.message.includes("日本時間"));
});

test("Claude 429（enforced_spend_limit_reached）→ spend_limit。ほかの 429 は rate_limit のまま", async () => {
  const enforced = { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "limit", details: { error_code: "enforced_spend_limit_reached" } } } };
  const claude = claudeWith([enforced, enforced]); // SDK が429を1回再送する
  await assert.rejects(claude.gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "spend_limit" && e.message.startsWith("Claude の月の上限（利用段階の上限）に達しました。"));
  const plain = claudeWith([429, 429]);
  await assert.rejects(plain.gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "rate_limit");
});

test("Claude：残高不足（400 credit balance・402）→ billing。401・403・404 → auth。ほかの 400 → api（残高の一文なし）", async () => {
  await assert.rejects(claudeWith([claudeBody("invalid_request_error", "Your credit balance is too low to access the Anthropic API.")]).gradeAnswer(question, "x"),
    (e) => e instanceof ClaudeError && e.reason === "billing" && e.message === "Claude の残高が足りません。Claude Console で残高を確かめてください。");
  await assert.rejects(claudeWith([402]).gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "billing");
  for (const status of [401, 403, 404]) await assert.rejects(claudeWith([status]).gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "auth", String(status));
  await assert.rejects(claudeWith([400]).gradeAnswer(question, "x"), (e) => e instanceof ClaudeError && e.reason === "api" && /HTTP 400/.test(e.message) && !/残高や月の支出/.test(e.message));
});

test("answer：Claude の上限を受けた後の10分は Gemini も Claude も呼ばない。10分後にまた呼ぶ", async () => {
  const a = makeApi();
  const s = await beginSession(a);
  a.ai.claudeFailures.push(claudeBody("invalid_request_error", WORKSPACE));
  const first = await a.postJson("/api/instant/answer", body(s, 0));
  assert.equal(first.status, 503);
  assert.equal(first.body.reason, "grading_failed");
  assert.equal(first.body.stage, "grading");
  assert.equal(first.body.providerReason, "spend_limit");
  assert.match(first.body.error, /月の上限/);
  assert.match(first.body.error, /日本時間 11月1日 9時/);
  assert.ok(first.body.audio);
  assert.equal(a.ai.geminiCalls.length, 1);
  assert.equal(a.ai.claudeCalls.length, 1);
  assert.deepEqual((await a.getJson("/api/instant/status")).body.providerBlock?.provider, "claude");
  // 止めている間
  a.clock.now += PROVIDER_BLOCK_MS - 1;
  const blocked = await a.postJson("/api/instant/answer", body(s, 1));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.reason, "grading_failed");
  assert.equal(blocked.body.providerReason, "spend_limit");
  assert.equal(a.ai.geminiCalls.length, 1);
  assert.equal(a.ai.claudeCalls.length, 1);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM instant_attempts")[0]?.n, 0); // 未採点＝記録しない
  assert.equal(a.db.all("SELECT count FROM daily_counters WHERE name = 'answer'")[0]?.count, 1); // 止めた分は数えない（1回目だけ）
  // 10分後
  a.clock.now += 1;
  const again = await a.postJson("/api/instant/answer", body(s, 1));
  assert.equal(again.status, 200);
  assert.equal(a.ai.geminiCalls.length, 2);
  assert.equal((await a.getJson("/api/instant/status")).body.providerBlock, null);
});

test("answer：Claude の auth・billing でも止める。rate_limit・通信の失敗は止めない", async () => {
  for (const [failure, expected] of [[401, "auth"], [402, "billing"]] as const) {
    const a = makeApi();
    const s = await beginSession(a);
    a.ai.claudeFailures.push(failure);
    assert.equal((await a.postJson("/api/instant/answer", body(s, 0))).body.providerReason, expected);
    assert.equal((await a.postJson("/api/instant/answer", body(s, 1))).body.providerReason, expected);
    assert.equal(a.ai.geminiCalls.length, 1);
  }
  const a = makeApi();
  const s = await beginSession(a);
  a.ai.claudeFailures.push("network", "network");
  assert.equal((await a.postJson("/api/instant/answer", body(s, 0))).status, 503);
  assert.equal((await a.postJson("/api/instant/answer", body(s, 1))).status, 200); // 止めていない
});

test("Gemini 402（payment_required）→ billing。専用モデルから flash に切り替えない", async () => {
  const { ai, gemini } = geminiWith([{ status: 402, body: { error: { code: "payment_required", message: "no balance" } } }]);
  await assert.rejects(transcribe(gemini), (e) => e instanceof GeminiError && e.reason === "billing" && e.httpStatus === 402
    && e.message === "Gemini の前払い残高がなくなりました。Google AI Studio で残高を追加するまで、聞き取りと読み上げは使えません。");
  assert.equal(ai.geminiCalls.length, 1);
});

test("Gemini 400 failed_precondition → billing（切り替えない）。401・403 → auth", async () => {
  const pre = geminiWith([{ status: 400, body: { error: { code: 400, message: "x", status: "FAILED_PRECONDITION" } } }]);
  await assert.rejects(transcribe(pre.gemini), (e) => e instanceof GeminiError && e.reason === "billing" && e.message === "Gemini の請求の設定を Google AI Studio で確かめてください。");
  assert.equal(pre.ai.geminiCalls.length, 1);
  for (const status of [401, 403]) {
    const g = geminiWith([status]);
    await assert.rejects(transcribe(g.gemini), (e) => e instanceof GeminiError && e.reason === "auth", String(status));
    assert.equal(g.ai.geminiCalls.length, 1);
  }
});

test("Gemini 429（quota_exceeded・RESOURCE_EXHAUSTED）→ quota で、切り替える。ほかの 429 は rate_limit で切り替える", async () => {
  await quietWarn(async () => {
    const quota = { status: 429, body: { error: { code: "quota_exceeded", message: "q", status: "RESOURCE_EXHAUSTED" } } };
    const ok = geminiWith([quota]);
    assert.equal((await transcribe(ok.gemini)).model, "gemini-3.8-flash");
    assert.equal(ok.ai.geminiCalls.length, 2);
    const both = geminiWith([quota, quota]);
    await assert.rejects(transcribe(both.gemini), (e) => e instanceof GeminiError && e.reason === "quota" && /割り当て/.test(e.message));
    const exhausted = geminiWith([{ status: 429, body: { error: { code: 429, message: "q", status: "RESOURCE_EXHAUSTED" } } }, 429]);
    await assert.rejects(transcribe(exhausted.gemini), (e) => e instanceof GeminiError && e.reason === "rate_limit" && /利用上限/.test(e.message)); // 切り替え先の無題の429
    assert.equal(exhausted.ai.geminiCalls.length, 2);
  });
});

test("answer：Gemini の billing を受けたら Gemini を10分止める。読み上げも 503 provider_blocked", async () => {
  const a = makeApi();
  const s = await beginSession(a);
  a.ai.geminiFailures.push({ status: 402, body: { error: { code: "payment_required", message: "x" } } });
  const first = await quietWarn(() => a.postJson("/api/instant/answer", body(s, 0)));
  assert.equal(first.status, 503);
  assert.equal(first.body.reason, "transcription_failed");
  assert.equal(first.body.stage, "transcription");
  assert.equal(first.body.providerReason, "billing");
  assert.match(first.body.error, /前払い残高/);
  assert.equal(a.ai.geminiCalls.length, 1);
  const second = await a.postJson("/api/instant/answer", body(s, 1));
  assert.equal(second.body.reason, "transcription_failed");
  assert.equal(second.body.providerReason, "billing");
  assert.equal(a.ai.geminiCalls.length, 1);
  assert.equal(a.ai.claudeCalls.length, 0);
  const speech = await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" });
  assert.equal(speech.status, 503);
  assert.equal(speech.body.reason, "provider_blocked");
  assert.equal(a.ai.geminiCalls.length, 1);
  assert.equal(a.db.all("SELECT COUNT(*) AS n FROM daily_counters WHERE name = 'speech'")[0]?.n, 0); // 止めた分は数えない
  a.clock.now += PROVIDER_BLOCK_MS;
  assert.equal((await a.postJson("/api/instant/answer", body(s, 1))).status, 200);
  assert.equal((await a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" })).status, 200);
});

test("読み上げで Gemini の billing を受けたら、以後の answer も止まる", async () => {
  const a = makeApi();
  const s = await beginSession(a);
  a.ai.geminiFailures.push({ status: 402, body: { error: { code: "payment_required", message: "x" } } });
  const speech = await quietWarn(() => a.postJson("/api/instant/speech", { questionId: "q001", kind: "prompt" }));
  assert.equal(speech.status, 503);
  const blocked = await a.postJson("/api/instant/answer", body(s, 0));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.providerReason, "billing");
  assert.equal(a.ai.geminiCalls.length, 1);
});

test("createProviderBlocker：期限が過ぎたら消える。any は claude を先に返す", () => {
  const b = createProviderBlocker();
  assert.equal(b.any(0), null);
  b.block("gemini", "billing", "g", 1000);
  b.block("claude", "auth", "c", 1000);
  assert.equal(b.any(1000)?.provider, "claude");
  assert.equal(b.active("gemini", 1000 + PROVIDER_BLOCK_MS - 1)?.reason, "billing");
  assert.equal(b.active("gemini", 1000 + PROVIDER_BLOCK_MS), null);
  assert.equal(b.any(1000 + PROVIDER_BLOCK_MS), null);
});
