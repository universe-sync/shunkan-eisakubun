// 偽の Gemini・Claude。fetch の代わりに渡す。呼ばれた本文を記録し、応答・失敗の順・usage を変えられる
export const clearAnswer = () => ({ transcript: "I'm a little tired today.", recognitionStatus: "clear" });
export const uncertainAnswer = () => ({ transcript: "", recognitionStatus: "uncertain" });
// 実測の書き起こし・採点の usage（Gemini：入力49・出力13・thinking 42 → 0.000243 USD）
export const gradingUsage = { total_input_tokens: 49, total_output_tokens: 13, total_thought_tokens: 42, total_tokens: 104, input_tokens_by_modality: [{ modality: "text", tokens: 11 }, { modality: "audio", tokens: 38 }] };
export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const claudeUsage = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 300, output_tokens_details: { thinking_tokens: 120 } }; // 0.00024 USD
export const claudeMessage = (grade: unknown, { stopReason = "end_turn", usage = claudeUsage }: { stopReason?: string; usage?: unknown } = {}) => ({ id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: typeof grade === "string" ? grade : JSON.stringify(grade) }], stop_reason: stopReason, stop_sequence: null, usage });
export const goodGrade = () => ({ reasonJa: "同じ意味です。", meaningEquivalent: true, meaningPercent: 95, grammarFeedbackJa: "自然です。", grammarScore: 19, correctedAnswerEn: "I'm a little tired today." });

/** 失敗の指定：数は HTTP の状態、"network" は通信の失敗、{status, body} は本文（JSON）つきの失敗 */
export type Failure = number | "network" | { status: number; body: unknown };
function failureResponse(failure: number | { status: number; body: unknown }, plain: unknown): Response {
  if (typeof failure === "number") return typeof plain === "string" ? new Response(plain, { status: failure }) : jsonResponse(plain, failure);
  return jsonResponse(failure.body, failure.status);
}

export function makeFakeAi() {
  const ai = {
    geminiCalls: [] as any[],
    claudeCalls: [] as any[],
    geminiAnswer: clearAnswer as (body?: any) => { transcript: string; recognitionStatus: string },
    geminiUsage: gradingUsage as unknown,
    /** 失敗を返したい順番（例 [500]・[429]・["network"]）。尽きたら成功を返す */
    geminiFailures: [] as Failure[],
    claudeReply: (() => claudeMessage(goodGrade())) as () => unknown,
    claudeFailures: [] as Failure[],
    /** 許可リストの外・想定外の送り先に来たら記録する */
    others: [] as string[],
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        const body = JSON.parse(String(init?.body));
        ai.geminiCalls.push(body);
        const failure = ai.geminiFailures.shift();
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure !== undefined) return failureResponse(failure, "error");
        // 聞き取り専用モデルは書き起こしの文字だけを返す（聞き取れなければ空）。切り替え先（gemini-3.8-flash）は JSON を返す。読み上げは音声を返す
        if (body.model === "gemini-3.8-flash-tts") return jsonResponse({ usage: ai.geminiUsage, steps: [{ type: "model_output", content: [{ type: "audio", data: fakeSpeechBase64() }] }] });
        const answerText = body.model === "gemini-3.5-transcribe" ? ai.geminiAnswer(body).transcript : JSON.stringify(ai.geminiAnswer(body));
        return new Response(JSON.stringify({ usage: ai.geminiUsage, steps: [{ type: "model_output", content: [{ type: "text", text: answerText }] }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://api.anthropic.com/")) {
        ai.claudeCalls.push(JSON.parse(String(init?.body)));
        const failure = ai.claudeFailures.shift();
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure !== undefined) return failureResponse(failure, { type: "error", error: { type: "api_error", message: "test" } });
        return jsonResponse(ai.claudeReply());
      }
      ai.others.push(url);
      throw new Error(`テストから外部へ通信しようとしました: ${url}`);
    },
  };
  return ai;
}
export type FakeAi = ReturnType<typeof makeFakeAi>;

/** 読み上げ用の小さな偽の WAV（RIFF/WAVE のヘッダーだけ正しい）の base64 */
export function fakeSpeechBase64(): string {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
