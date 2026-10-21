// 外向きの fetch の許可リスト。許可しない送り先は、その場で例外を投げず、拒否された Promise で返す
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaude } from "../src/server/ai/claude";
import { createGemini } from "../src/server/ai/gemini";
import { ALLOWED_PREFIXES, OUTBOUND_REFUSED_MESSAGE, outboundFetch } from "../src/server/ai/outbound";
import { instantQuestions } from "../src/server/instant/questions";
import { forbidNetwork } from "./helpers/no-network";
import { makeFakeAi } from "./helpers/fake-ai";

forbidNetwork();

test("許可リストは Gemini と Anthropic だけ", () => {
  assert.deepEqual([...ALLOWED_PREFIXES], ["https://generativelanguage.googleapis.com/", "https://api.anthropic.com/"]);
});

test("許可しない送り先は同期の例外ではなく、拒否された Promise を返し、元の fetch は呼ばれない", async () => {
  const called: string[] = [];
  const guarded = outboundFetch(async (url) => { called.push(url); return new Response("ok"); });
  for (const url of [
    "https://example.com/", "http://api.anthropic.com/v1/messages", "https://api.anthropic.com.evil.example/v1/messages",
    "https://api.anthropic.com@evil.example/v1", "https://user:pw@api.anthropic.com/v1", "https://generativelanguage.googleapis.com.evil.example/",
    "https://generativelanguage.googleapis.com", "https://API.anthropic.com/", "//api.anthropic.com/", "file:///etc/passwd", "", " https://api.anthropic.com/",
  ]) {
    let promise: Promise<Response> | undefined;
    assert.doesNotThrow(() => { promise = guarded(url); }, `同期で例外を投げた: ${url}`);
    assert.ok(promise instanceof Promise, url);
    await assert.rejects(promise as Promise<Response>, new Error(OUTBOUND_REFUSED_MESSAGE), url);
  }
  // 文字列でない値でも、同期の例外にならない
  let weird: Promise<Response> | undefined;
  assert.doesNotThrow(() => { weird = guarded(undefined as unknown as string); });
  await assert.rejects(weird as Promise<Response>, /許可されていない送り先です/);
  assert.deepEqual(called, []);
});

test("許可した送り先は元の fetch に渡り、その応答がそのまま返る", async () => {
  const called: Array<[string, string | undefined]> = [];
  const guarded = outboundFetch(async (url, init) => { called.push([url, init?.method]); return new Response("ok", { status: 201 }); });
  const a = await guarded("https://api.anthropic.com/v1/messages", { method: "POST" });
  const g = await guarded("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST" });
  assert.equal(a.status, 201);
  assert.equal(g.status, 201);
  assert.deepEqual(called, [["https://api.anthropic.com/v1/messages", "POST"], ["https://generativelanguage.googleapis.com/v1beta/interactions", "POST"]]);
});

test("許可リスト＋偽の通信：Gemini と Claude の部品は許可リスト越しに偽の API へ届く。許可外へは行かない", async () => {
  const ai = makeFakeAi();
  const guarded = outboundFetch(ai.fetch);
  const gemini = createGemini({ apiKey: () => "test-only", fetch: guarded, wait: async () => {} });
  const claude = createClaude({ apiKey: () => "test-only", fetch: guarded });
  const heard = await gemini.transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
  assert.equal(heard.recognitionStatus, "clear");
  const grading = await claude.gradeAnswer(instantQuestions[0]!, heard.transcript);
  assert.equal(grading.model, "claude-haiku-5-5");
  assert.equal(ai.geminiCalls.length, 1);
  assert.equal(ai.claudeCalls.length, 1);
  assert.deepEqual(ai.others, []); // 偽の通信が「許可外」を受けていない
  // 許可外は偽の通信にも届かない
  await assert.rejects(guarded("https://example.com/x", { method: "POST" }), /許可されていない送り先です/);
  assert.deepEqual(ai.others, []);
});
