import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { instantQuestions } from "../src/server/instant/questions";
import { asciiAt } from "../src/server/bytes";
import { GEMINI_RETRY_DELAY_MS, GeminiError, TRANSCRIPTION_PROMPT, createGemini, validateTranscription, type Gemini } from "../src/server/ai/gemini";

forbidNetwork();
// 元の試験は gemini.js のモジュール関数を直に呼んでいた。今は createGemini で作った部品を呼ぶ。withFakeGemini の中だけで作り直す
let current: Gemini;
let usageRecorder: ((model: string, usage: unknown) => unknown) | null = null;
let waits: number[] = [];
const transcribeSpeech = (...args: Parameters<Gemini["transcribeSpeech"]>) => current.transcribeSpeech(...args);
const synthesizeSpeech = (...args: Parameters<Gemini["synthesizeSpeech"]>) => current.synthesizeSpeech(...args);
const setUsageRecorder = (fn: ((model: string, usage: unknown) => unknown) | null) => { usageRecorder = fn; };

test("Gemini の書き起こし結果の型と範囲を検証する", () => {
  assert.deepEqual(validateTranscription({ transcript: "  Can I call you later?  ", recognitionStatus: "clear" }), { recognitionStatus: "clear", transcript: "Can I call you later?" });
  assert.deepEqual(validateTranscription({ transcript: "   ", recognitionStatus: "clear" }), { recognitionStatus: "empty", transcript: "" }); // 聞き取れたと言いながら空
  assert.deepEqual(validateTranscription({ transcript: "uh", recognitionStatus: "uncertain" }), { recognitionStatus: "uncertain", transcript: "uh" });
  assert.throws(() => validateTranscription({ transcript: "hi", recognitionStatus: "maybe" }), GeminiError);
  assert.throws(() => validateTranscription({ transcript: "a".repeat(1201), recognitionStatus: "clear" }), GeminiError);
  assert.throws(() => validateTranscription({ transcript: 5, recognitionStatus: "clear" }), GeminiError);
  assert.throws(() => validateTranscription(null), GeminiError);
});

test("書き起こしは聞き取り専用モデルへ設定だけで送り（文字の指示・問題文なし）、読み上げは別モデルで非保存", async () => {
  const replies = [
    { steps: [{ type: "model_output", content: [{ type: "text", text: "Could you hang up the laundry?" }] }] },
    { steps: [{ type: "model_output", content: [{ type: "audio", data: wavHeaderBase64 }] }] }
  ];
  await withFakeGemini(replies, async (requests) => {
    const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
    assert.deepEqual(result, { recognitionStatus: "clear", transcript: "Could you hang up the laundry?", model: "gemini-3.5-transcribe" });
    const audio = await synthesizeSpeech(instantQuestions[0]!.referenceAnswer);
    assert.equal(asciiAt(audio, 0, 4), "RIFF");
    assert.ok(audio instanceof Uint8Array);
    assert.equal(requests[0].model, "gemini-3.5-transcribe");
    assert.equal(requests[0].input.length, 1);
    assert.equal(requests[0].input[0].type, "audio");
    assert.equal(requests[0].input[0].mime_type, "audio/wav");
    assert.deepEqual(requests[0].generation_config, { transcription_config: { language_codes: ["en-US"], mode: { type: "verbatim" } } });
    assert.equal(requests[0].generation_config.thinking_level, undefined);
    assert.equal(requests[0].response_format, undefined);
    const body = JSON.stringify(requests[0]);
    assert.ok(instantQuestions.every((item) => !body.includes(item.referenceAnswer) && !body.includes(item.japanese)));
    assert.equal(requests[1].model, "gemini-3.8-flash-tts");
    assert.equal(requests[1].response_format.type, "audio");
    assert.ok(requests.every((request) => request.store === false));
  });
});

test("読み上げの速さ：第3引数で英語の指示が変わる。日本語は速さに関係なく同じ", async () => {
  const reply = { steps: [{ type: "model_output", content: [{ type: "audio", data: wavHeaderBase64 }] }] };
  await withFakeGemini([reply, reply, reply, reply, reply], async (requests) => {
    const style = (request: any) => request.input[0].content[0].annotations[0].style as string;
    await synthesizeSpeech("hello");
    await synthesizeSpeech("hello", "en");
    await synthesizeSpeech("hello", "en", "normal");
    await synthesizeSpeech("hello", "en", "slow");
    await synthesizeSpeech("こんにちは", "ja", "slow");
    assert.match(style(requests[0]), /normal conversational pace/);
    assert.equal(style(requests[1]), style(requests[0]));
    assert.equal(style(requests[2]), style(requests[0]));
    assert.match(style(requests[3]), /slightly slower than normal conversation/);
    assert.doesNotMatch(style(requests[3]), /normal conversational/);
    assert.match(style(requests[4]), /Japanese/);
    assert.doesNotMatch(style(requests[4]), /slowly/);
  });
});

test("聞き取り専用モデルの応答が空・空白だけなら empty（作らない）", async () => {
  for (const text of ["", "  \n "]) {
    await withFakeGemini([plainReply(text)], async (calls) => {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.deepEqual(result, { recognitionStatus: "empty", transcript: "", model: "gemini-3.5-transcribe" });
      assert.equal(calls.length, 1);
    });
  }
});

test("上限（429）のときは gemini-3.8-flash（thinking medium・手がかりなし）に切り替える", async () => {
  await withFakeGemini([429, clearReply()], async (calls) => {
    const originalWarn = console.warn; console.warn = () => {};
    try {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.deepEqual(result, { recognitionStatus: "clear", transcript: "I'm tired.", model: "gemini-3.8-flash" });
    } finally { console.warn = originalWarn; }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, "gemini-3.5-transcribe");
    assert.equal(calls[1].model, "gemini-3.8-flash");
    assert.equal(calls[1].generation_config.thinking_level, "medium");
    assert.equal(calls[1].input[0].text, TRANSCRIPTION_PROMPT);
    assert.equal(calls[1].input[1].type, "audio");
    assert.equal(calls[1].response_format.mime_type, "application/json");
    assert.deepEqual(Object.keys(calls[1].response_format.schema.properties).sort(), ["recognitionStatus", "transcript"]);
    const body = JSON.stringify(calls[1]);
    assert.ok(instantQuestions.every((item) => !body.includes(item.referenceAnswer) && !body.includes(item.japanese)));
    assert.ok(calls.every((request) => request.store === false));
  });
});

test("5xx を2回（再送を含む）・通信の失敗・時間切れ・形の不正でも切り替える", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (const [first, expectedCalls] of [[[500], 2], [["network"], 2], [["timeout"], 2], [[plainReply("a".repeat(1201))], 2]] as [any[], number][]) {
      await withFakeGemini([...first, clearReply()], async (calls) => {
        const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
        assert.equal(result.model, "gemini-3.8-flash");
        assert.equal(calls.length, expectedCalls);
        assert.equal(calls.at(-1).model, "gemini-3.8-flash");
      });
    }
  } finally { console.warn = originalWarn; }
});

test("聞き取り専用モデルは 5xx でも再送せず、時間切れは20秒の指定で、すぐ切り替える", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  const originalTimeout = AbortSignal.timeout; const timeouts: number[] = [];
  AbortSignal.timeout = (ms: number) => { timeouts.push(ms); return originalTimeout.call(AbortSignal, ms); };
  try {
    await withFakeGemini([500, clearReply()], async (calls) => {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.equal(result.model, "gemini-3.8-flash");
      assert.deepEqual(calls.map((request) => request.model), ["gemini-3.5-transcribe", "gemini-3.8-flash"]); // 専用は fetch 1回だけ
    });
    assert.deepEqual(timeouts, [20000, 90000]); // 専用20秒・切り替え先は今のまま90秒
    timeouts.length = 0;
    await withFakeGemini(["timeout", clearReply()], async (calls) => {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.equal(result.model, "gemini-3.8-flash");
      assert.equal(calls.length, 2);
    });
    assert.equal(timeouts[0], 20000);
  } finally { AbortSignal.timeout = originalTimeout; console.warn = originalWarn; }
});

test("区切られた text は空白1つでつなぎ、連続の空白をまとめる", async () => {
  const reply = { steps: [{ type: "model_output", content: [{ type: "text", text: "Could you " }, { type: "text", text: "  hang up the\n laundry?" }] }] };
  await withFakeGemini([reply], async () => {
    const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
    assert.equal(result.transcript, "Could you hang up the laundry?");
  });
});

test("応答の形が崩れても TypeError にならない：steps が配列でなければ切り替え、steps はあるが text が無ければ empty", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (const bad of [{}, { steps: "x" }, null, { steps: {} }]) {
      await withFakeGemini([bad, clearReply()], async (calls) => {
        const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
        assert.equal(result.model, "gemini-3.8-flash");
        assert.equal(calls.length, 2);
      });
    }
    for (const empty of [{ steps: [] }, { steps: [{ type: "model_output" }] }, { steps: [{ type: "model_output", content: "x" }] }, { steps: [null, { type: "model_output", content: [null, { type: "text" }] }] }]) {
      await withFakeGemini([empty], async (calls) => {
        const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
        assert.deepEqual(result, { recognitionStatus: "empty", transcript: "", model: "gemini-3.5-transcribe" });
        assert.equal(calls.length, 1);
      });
    }
  } finally { console.warn = originalWarn; }
});

test("キー（GEMINI_API_KEY）が無いときは切り替えずにすぐ失敗し、fetch は0回で、切り替えの警告も出さない", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await withFakeGemini([clearReply()], async (calls) => {
      await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), (error) => error instanceof GeminiError && /APIキーが未設定/.test(error.message) && /GEMINI_API_KEY/.test(error.message) && /Variables and Secrets/.test(error.message));
      assert.equal(calls.length, 0);
    }, { key: null });
    assert.equal(warnings.length, 0);
  } finally { console.warn = originalWarn; }
});

test("401・403（キーや権限）は切り替えずにそのまま失敗する", async () => {
  for (const status of [401, 403]) {
    await withFakeGemini([status, clearReply()], async (calls) => {
      await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), (error: any) => error instanceof GeminiError && error.httpStatus === status);
      assert.equal(calls.length, 1);
    });
  }
});

test("両方失敗したら、切り替え先の GeminiError をそのまま投げる", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await withFakeGemini([429, 400], async (calls) => {
      await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), (error) => error instanceof GeminiError && error.httpStatus === 400);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].model, "gemini-3.8-flash");
    });
  } finally { console.warn = originalWarn; }
});

test("切り替え先が聞き取れないと答えたときは、状態と書き起こしだけを返す", async () => {
  const uncertain = { steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ transcript: "", recognitionStatus: "uncertain" }) }] }] };
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await withFakeGemini([429, uncertain], async () => {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.deepEqual(result, { recognitionStatus: "uncertain", transcript: "", model: "gemini-3.8-flash" });
    });
  } finally { console.warn = originalWarn; }
});

// ---- Gemini：再送と利用量の記録（fetch は偽物）----
async function withFakeGemini(responses: any[], work: (calls: any[]) => unknown, { key = "test-only" as string | null } = {}) {
  const calls: any[] = [];
  waits = [];
  const fakeFetch = async (_url: string, options?: RequestInit) => {
    calls.push(JSON.parse(String(options?.body)));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === "network") throw new TypeError("fetch failed");
    if (next === "timeout") throw new DOMException("timed out", "TimeoutError");
    if (typeof next === "number") return new Response("error", { status: next });
    return new Response(JSON.stringify(next), { status: 200 });
  };
  current = createGemini({ apiKey: () => key ?? undefined, fetch: fakeFetch, recordUsage: async (model, usage) => { await usageRecorder?.(model, usage); }, wait: async (ms) => { waits.push(ms); } });
  try { return await work(calls); } finally { setUsageRecorder(null); }
}
const plainReply = (text: string, usage?: unknown) => ({ usage, steps: [{ type: "model_output", content: [{ type: "text", text }] }] }); // 聞き取り専用モデルの応答（書き起こしの文字だけ）
const clearReply = (usage?: unknown) => ({ usage, steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ transcript: "I'm tired.", recognitionStatus: "clear" }) }] }] });
const wavHeader = (() => { const wav = new Uint8Array(44); wav.set([0x52, 0x49, 0x46, 0x46], 0); wav.set([0x57, 0x41, 0x56, 0x45], 8); return wav; })();
const wavHeaderBase64 = btoa(String.fromCharCode(...wavHeader));

test("切り替え先は 503 のあとに成功を返すと1回再送して結果を返す（聞き取り専用モデルは再送しない）", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await withFakeGemini([429, 503, clearReply()], async (calls) => {
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.deepEqual(result, { recognitionStatus: "clear", transcript: "I'm tired.", model: "gemini-3.8-flash" });
      assert.deepEqual(calls.map((request) => request.model), ["gemini-3.5-transcribe", "gemini-3.8-flash", "gemini-3.8-flash"]);
      assert.deepEqual(waits, [GEMINI_RETRY_DELAY_MS]); // 待ちは注入した wait で記録する（本物の時間は待たない）
    });
  } finally { console.warn = originalWarn; }
});

test("429 と 400 は各モデルで再送しない（聞き取り専用→切り替え先の1回ずつ）", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (const status of [429, 400]) {
      await withFakeGemini([status], async (calls) => {
        await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), (error) => error instanceof GeminiError && error.status === 503 && error.httpStatus === status && (status !== 429 || /利用上限/.test(error.message)));
        assert.equal(calls.length, 2);
      });
    }
  } finally { console.warn = originalWarn; }
});

test("通信の失敗は、聞き取り専用モデルは1回・切り替え先は2回で諦め、時間切れは再送しない", async () => {
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await withFakeGemini(["network"], async (calls) => {
      await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), /接続に失敗/);
      assert.equal(calls.length, 3);
    });
    await withFakeGemini(["timeout"], async (calls) => {
      await assert.rejects(transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }), /接続に失敗/);
      assert.equal(calls.length, 2);
    });
  } finally { console.warn = originalWarn; }
});

test("利用量の記録係は書き起こしと読み上げの両方で呼ばれ、記録の失敗は結果に影響しない", async () => {
  const gradingUsage = { total_input_tokens: 49, total_output_tokens: 13, total_thought_tokens: 42 };
  const speechUsage = { total_input_tokens: 9, total_output_tokens: 71 };
  const speechReply = { usage: speechUsage, steps: [{ type: "model_output", content: [{ type: "audio", data: wavHeaderBase64 }] }] };
  await withFakeGemini([plainReply("I'm tired.", gradingUsage), speechReply], async () => {
    const recorded: any[] = [];
    setUsageRecorder(async (model, usage) => { recorded.push([model, usage]); });
    await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
    await synthesizeSpeech("hello");
    assert.deepEqual(recorded, [["gemini-3.5-transcribe", gradingUsage], ["gemini-3.8-flash-tts", speechUsage]]);
  });
  await withFakeGemini([plainReply("I'm tired.", gradingUsage)], async () => {
    const originalWarn = console.warn; console.warn = () => {};
    try {
      setUsageRecorder(async () => { throw new Error("disk full"); });
      const result = await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
      assert.equal(result.recognitionStatus, "clear");
    } finally { console.warn = originalWarn; }
  });
});

test("切り替えた分は gemini-3.8-flash の桶に記録される（429 の中身の無い失敗は記録しない）", async () => {
  const usage = { total_input_tokens: 5, total_output_tokens: 5 };
  const recorded: any[] = [];
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await withFakeGemini([429, clearReply(usage)], async () => {
      setUsageRecorder(async (model, u) => { recorded.push([model, u]); });
      await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" });
    });
  } finally { console.warn = originalWarn; }
  assert.deepEqual(recorded, [["gemini-3.8-flash", usage]]);
});

test("時間切れ・切断で終わった呼び出しは usage なしで1回だけ記録し、再送して成功した場合は二重に数えない", async () => {
  const run = async (responses: any[]) => {
    const recorded: any[] = [];
    await withFakeGemini(responses, async () => {
      setUsageRecorder(async (model, usage) => { recorded.push([model, usage]); });
      await transcribeSpeech({ audioBase64: "dGVzdA==", mimeType: "audio/wav" }).catch(() => {});
    });
    return recorded;
  };
  const originalWarn = console.warn; console.warn = () => {};
  try {
    // 聞き取り専用が時間切れ → 切り替え先も時間切れ：それぞれ1回
    assert.deepEqual(await run(["timeout"]), [["gemini-3.5-transcribe", undefined], ["gemini-3.8-flash", undefined]]);
    assert.deepEqual(await run(["network"]), [["gemini-3.5-transcribe", undefined], ["gemini-3.8-flash", undefined]]); // 切り替え先で2回失敗しても記録は1回
    const usage = { total_input_tokens: 5, total_output_tokens: 5 };
    assert.deepEqual(await run(["network", clearReply(usage)]), [["gemini-3.5-transcribe", undefined], ["gemini-3.8-flash", usage]]);
    assert.deepEqual(await run([plainReply("hi", usage)]), [["gemini-3.5-transcribe", usage]]);
    assert.deepEqual(await run([429, "network", clearReply(usage)]), [["gemini-3.8-flash", usage]]); // 切り替え先の1回目の失敗は数えない（429 の専用は記録しない）
  } finally { console.warn = originalWarn; }
});

