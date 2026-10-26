import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { audioSummary, inspectSpeechWav } from "../../shared/audio.js";
import { APP_NAME } from "../../shared/app-info.js";
import { QUESTION_COUNT_DEFAULT, parseQuestionCount, parseQuestionSeconds } from "../../shared/instant-rules.js";
import { createClaude, ClaudeError } from "../ai/claude";
import { createGemini, GeminiError } from "../ai/gemini";
import { clientKey } from "../gate/policy";
import { USER_KEY_HEADER, decodeUserKey } from "../gate/user-token";
import { TRIAL_SESSION_SIZE } from "../../shared/trial-rules.js";
import { guardConfig, type GuardEnv } from "../guard/config";
import { checkAnswerCapacity, dailyLimitMessage, dailyState, reserveDaily, type DailyLimit } from "../guard/daily-limits";
import { BLOCKING_REASONS, createProviderBlocker, type Provider, type ProviderBlock } from "../guard/provider-block";
import { hitRate } from "../guard/rate-limit";
import type { FetchLike } from "../ai/outbound";
import { base64ToBytes } from "../bytes";
import { HttpError, readJsonObject } from "../http";
import { requestPath } from "../path";
import type { Db } from "../store/db";
import { schemaVersion } from "../store/migrate";
import { jstDate } from "../time";
import { trialClosed, trialConfig, type TrialEnv } from "../trial/config";
import { answerGate, findUser, speechGate, touchUser, trialInfo, trialToday } from "../trial/users";
import { createUsageStore } from "../usage/store";
import { instantQuestionById } from "./questions";
import { createInstantSettings } from "./settings";
import { createInstantStore, noAnswerEvaluation } from "./store";

export interface InstantEnv extends GuardEnv, TrialEnv { GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string }
export interface InstantApiDeps {
  db: Db;
  env: InstantEnv;
  now(): number;
  newId(): string;
  randomInt(maxExclusive: number): number;
  fetch: FetchLike;
  wait?(ms: number): Promise<void>;
}

// 16kHz・16bit・モノラルは毎秒32,000バイト、ヘッダー44バイト。1区間の録音は最長60秒で、受け付けは65秒（余裕5秒）まで：
// 65秒＝2,080,044バイト → base64 は 4×⌈2,080,044÷3⌉＝2,773,392文字（60秒は2,560,060文字）。余裕をとって2,800,000文字（約65.6秒分）を上限にする。
// JSON の上限は 4MiB（4,194,304バイト）で、この上限の base64 が収まる。
export const MAX_AUDIO_BASE64 = 2_800_000;
export const ANSWER_BODY_LIMIT = 4_194_304;
export const DEFAULT_BODY_LIMIT = 61_440;

const SEGMENT_ENDS = new Set(["timeout", "next", "stopped"]);
// 答える時間が終わった区間（1問の時間切れ・Tab や「次へ」で進んだ）。声が無ければ「回答なし」の不合格にする
const WINDOW_CLOSED = new Set(["timeout", "next"]);
const NAME_REQUIRED = "お試しに参加する名前が登録されていません。ページを再読み込みして、名前を入れてください。";
const NOT_ANSWERABLE = { error: "この問題の回答は受け付けられません（記録済み、または出題が終わりました）。画面を更新してください。", reason: "not_answerable" };

export function createInstantApi(d: InstantApiDeps): Hono {
  const app = new Hono({ getPath: requestPath });
  const trial = trialConfig(d.env);
  // 1人用（user_key ''）の store・settings は1つだけ作る。お試しでは要求ごとに、Worker が付けた X-User-Key の人で束ねて作る
  const soloStore = createInstantStore({ db: d.db, now: d.now, newId: d.newId, randomInt: d.randomInt, userKey: "" });
  const soloSettings = createInstantSettings(d.db, d.now, "");
  // 1人用は ''。お試しでは ''（1人用の記録）に届く道を作らない：鍵が無ければ 403
  const userKeyOf = (c: any): string => {
    if (!trial.enabled) return "";
    const key = decodeUserKey(c.req.header(USER_KEY_HEADER));
    if (key === null) throw new HttpError(403, NAME_REQUIRED, "trial_name_required");
    return key;
  };
  const storeOf = (c: any) => (trial.enabled ? createInstantStore({ db: d.db, now: d.now, newId: d.newId, randomInt: d.randomInt, userKey: userKeyOf(c) }) : soloStore);
  const settingsOf = (c: any) => (trial.enabled ? createInstantSettings(d.db, d.now, userKeyOf(c)) : soloSettings);
  const usage = createUsageStore(d.db, d.now);
  const recordUsage = (model: string, u: unknown): void => { usage.record(model, u); };
  const gemini = createGemini({ apiKey: () => d.env.GEMINI_API_KEY, fetch: d.fetch, recordUsage, ...(d.wait ? { wait: d.wait } : {}) });
  const claude = createClaude({ apiKey: () => d.env.ANTHROPIC_API_KEY, fetch: d.fetch, recordUsage });
  const cfg = guardConfig(d.env);
  const blocker = createProviderBlocker();
  const daily = () => dailyState(d.db, cfg, d.now(), usage.todayJpy());

  // 上限・残高切れ・キーの誤りを受けた提供元は、10分のあいだ呼ばない
  const noteFailure = (provider: Provider, error: unknown): void => {
    const e = error as { reason?: unknown; message?: unknown } | null;
    if (error instanceof GeminiError || error instanceof ClaudeError) {
      if (typeof e?.reason === "string" && BLOCKING_REASONS.has(e.reason)) blocker.block(provider, e.reason, String(e.message), d.now());
    }
  };
  const dailyRefusal = (c: any, limit: DailyLimit, extra: Record<string, unknown> = {}) => c.json({ error: dailyLimitMessage(limit, cfg), reason: "daily_limit", limit, ...extra }, 429);
  // 音声を送る回答・読み上げは、本文を読む前に IP ごとの頻度を数える
  const rateRefusal = (c: any, bucket: "answer" | "speech", perMinute: number) => {
    const hit = hitRate(d.db, bucket, clientKey(c.req.raw), perMinute, d.now());
    if (hit.ok) return null;
    const wait = hit.retryAfterSec ?? 60;
    c.header("Retry-After", String(wait));
    return c.json({ error: `短い時間に送りすぎています。${wait}秒ほど待ってから続けてください。`, reason: "rate_limited", retryAfterSec: wait }, 429);
  };

  const instantError = (c: any, error: unknown) => {
    const e = error as { status?: number; message?: string; reason?: string } | null;
    const status = e && typeof e.status === "number" ? e.status : undefined;
    if (status === undefined) console.warn("瞬間英作文の処理で想定外のエラー:", error instanceof Error ? error.message : error);
    const reason = error instanceof HttpError && error.reason ? { reason: error.reason } : {};
    return c.json({ error: status ? (e as { message: string }).message : "瞬間英作文の処理に失敗しました。", ...reason }, (status ?? 500) as ContentfulStatusCode);
  };

  // 外部APIの失敗は未採点（記録しない・連続合格は変えない）。どちらの段階で失敗したかを reason で返す
  const unscored = (c: any, stage: "transcription" | "grading", error: unknown, audio: Parameters<typeof audioSummary>[0], extra: Record<string, unknown> = {}) => {
    const known = error instanceof GeminiError || error instanceof ClaudeError;
    if (!known) console.warn(`瞬間英作文の${stage === "transcription" ? "聞き取り" : "採点"}で想定外のエラー:`, error instanceof Error ? error.message : error);
    const reason = stage === "transcription" ? "transcription_failed" : (error as { reason?: string })?.reason === "refused" ? "grading_refused" : "grading_failed";
    const fallback = stage === "transcription" ? "聞き取り（Gemini）の処理に失敗しました。" : "採点（Claude）の処理に失敗しました。";
    const providerReason = known && typeof (error as { reason?: unknown }).reason === "string" ? { providerReason: (error as { reason: string }).reason } : {};
    return c.json({ error: known ? (error as Error).message : fallback, reason, stage, ...providerReason, audio: audioSummary(audio), ...extra }, 503);
  };

  app.get("/api/health", (c) => c.json({ ok: true, app: APP_NAME, schemaVersion: schemaVersion(d.db) }));

  // お試しモードの前段：/api/health 以外は、登録済みの名前の人だけ通す（本文を読む前に断る）。1人用では登録しない
  if (trial.enabled) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/api/health") return next();
      const key = decodeUserKey(c.req.header(USER_KEY_HEADER));
      if (key === null || findUser(d.db, key) === null) return c.json({ error: NAME_REQUIRED, reason: "trial_name_required" }, 403);
      touchUser(d.db, key, d.now());
      return next();
    });
    app.get("/api/trial/me", (c) => {
      try { return c.json({ trial: trialInfo(d.db, trial, userKeyOf(c), d.now()) }); } catch (error) { return instantError(c, error); }
    });
  }
  const trialOf = (c: any) => trialInfo(d.db, trial, userKeyOf(c), d.now());
  const dailyDoneMessage = `今日のお試しは終了しました（1日${trial.questionsPerDay}問まで）。日本時間の0時を過ぎると、また使えます。`;
  const answersReachedMessage = `今日のお試しの問題数（1日${trial.questionsPerDay}問）に達したため、この回答は記録しませんでした。日本時間の0時を過ぎると、また使えます。`;
  const speechDoneMessage = `今日の読み上げ（1日${trial.speechPerDay}回まで）は終わりました。一度再生した文は、このページを開いている間は何度でも聞けます。日本時間の0時を過ぎると、また使えます。`;

  app.get("/api/instant/status", (c) => {
    try {
      const block: ProviderBlock | null = blocker.any(d.now());
      return c.json({ ...storeOf(c).status(), geminiConfigured: gemini.configured(), claudeConfigured: claude.configured(), daily: daily(), providerBlock: block ? { provider: block.provider, message: block.message } : null, ...(trial.enabled ? { trial: trialOf(c) } : {}) });
    } catch (error) { return instantError(c, error); }
  });
  app.get("/api/instant/settings", (c) => {
    try { return c.json(settingsOf(c).get()); } catch (error) { return instantError(c, error); }
  });
  app.put("/api/instant/settings", async (c) => {
    try { return c.json(settingsOf(c).set(await readJsonObject(c, DEFAULT_BODY_LIMIT))); } catch (error) { return instantError(c, error); }
  });
  app.post("/api/instant/start", async (c) => {
    try {
      const body = await readJsonObject(c, DEFAULT_BODY_LIMIT);
      // 古い画面から数が来ないときは10問。来たのに 10・20・30・50 以外なら400（出題は作らない）
      const questionCount = body.questionCount === undefined ? QUESTION_COUNT_DEFAULT : parseQuestionCount(body.questionCount);
      if (questionCount === undefined) return c.json({ error: "問題数は10・20・30・50問のどれかで指定してください。" }, 400);
      // 1問の時間は記録のためだけ。来ないときは記録しない。来たのに正しくなければ400
      const questionSeconds = body.questionSeconds === undefined ? undefined : parseQuestionSeconds(body.questionSeconds);
      if (body.questionSeconds !== undefined && questionSeconds === undefined) return c.json({ error: "1問の時間は10〜30秒（1秒刻み）で指定してください。" }, 400);
      const store = storeOf(c);
      // お試し：期間が終わっていたら、続きからの開始も止める
      if (trial.enabled && trialClosed(trial, d.now())) return c.json({ error: "お試し期間は終わりました。ご協力ありがとうございました。", reason: "trial_closed", trial: trialOf(c) }, 403);
      // 出題を作る前に、今日の採点の回数か利用料の上限に達していないかを見る（出題を作らない）
      const capacity = checkAnswerCapacity(d.db, cfg, d.now(), usage.todayJpy());
      if (!capacity.ok) return dailyRefusal(c, capacity.limit as DailyLimit);
      // お試し：今日の残りが 0 なら出題を作らない（続きからも止める）。残りより多くは出さない。1回は 10 問に固定
      let maxCount: number | undefined;
      if (trial.enabled) {
        const remaining = trial.questionsPerDay - trialToday(d.db, userKeyOf(c), jstDate(d.now())).answers;
        if (remaining <= 0) return c.json({ error: dailyDoneMessage, reason: "trial_daily_done", trial: trialOf(c) }, 429);
        maxCount = remaining;
      }
      // 真なら文字にして比べる（文字でない値を送っても、世代の確かめを素通りしない）
      return c.json(store.start(body.generationId ? String(body.generationId) : undefined, { questionSeconds, questionCount: trial.enabled ? TRIAL_SESSION_SIZE : questionCount, ...(maxCount !== undefined ? { maxCount } : {}) }));
    } catch (error) { return instantError(c, error); }
  });

  app.post("/api/instant/answer", async (c) => {
    try {
      const limited = rateRefusal(c, "answer", cfg.rateAnswerPerMinute);
      if (limited) return limited;
      const { sessionId, questionId, mimeType, audioBase64, segmentEnd } = await readJsonObject(c, ANSWER_BODY_LIMIT);
      if (typeof sessionId !== "string" || typeof questionId !== "string" || !instantQuestionById.has(questionId) || typeof audioBase64 !== "string" || audioBase64.length < 1200 || audioBase64.length > MAX_AUDIO_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || (segmentEnd !== undefined && !SEGMENT_ENDS.has(segmentEnd as string))) return c.json({ error: "録音データの形式が正しくありません。" }, 400);
      if (String(mimeType || "").split(";")[0]?.trim().toLowerCase() !== "audio/wav") return c.json({ error: "録音はWAV形式で送る必要があります。画面を再読み込みしてから、もう一度録音してください。" }, 400);
      let bytes: Uint8Array;
      try { bytes = base64ToBytes(audioBase64); } catch { return c.json({ error: "録音データの形式が正しくありません。" }, 400); } // 形は合っていても base64 として読めないもの
      const audio = inspectSpeechWav(bytes); // 形式の誤りは WavFormatError（status 400）→ instantError が400で返す
      const store = storeOf(c);
      const expected = store.checkAnswerable(sessionId, questionId);
      if (!expected) return c.json(NOT_ANSWERABLE, 409);
      if (!audio.detection.hasSpeech) {
        // segmentEnd が無いときは「停止」と同じく記録しない（時間切れ・次へと明示されたときだけ不合格にする）
        if (!WINDOW_CLOSED.has(segmentEnd as string)) return c.json({ error: "音声を検出できませんでした。もう一度話してください。", reason: "no_speech", audio: audioSummary(audio) }, 422);
        // 答える時間が終わった区間に声が無い＝回答なし。外部 API を呼ばずに不合格として記録する
        // お試し：今日の上限を数えるのは記録の直前（check と record の間に await を挟まない）
        if (trial.enabled && answerGate(d.db, trial, userKeyOf(c)).check(jstDate(d.now()))) return c.json({ error: answersReachedMessage, reason: "trial_daily_done", trial: trialOf(c), audio: audioSummary(audio) }, 429);
        const empty = store.record(sessionId, questionId, expected, noAnswerEvaluation(segmentEnd as string));
        if (!empty) return c.json(NOT_ANSWERABLE, 409);
        return c.json({ ...empty, audio: audioSummary(audio) });
      }
      // Gemini だけ課金されて採点できない、を避けるため、先に Claude のキーを確かめる
      if (!claude.configured()) return unscored(c, "grading", new ClaudeError("Claude APIキーが未設定です。Cloudflare の Variables and Secrets に ANTHROPIC_API_KEY を登録してください。", 503, "not_configured"), audio);
      // 上限・残高切れを受けて止めている提供元は呼ばない
      const claudeBlock = blocker.active("claude", d.now());
      if (claudeBlock) return unscored(c, "grading", new ClaudeError(claudeBlock.message, 503, claudeBlock.reason), audio);
      const geminiBlock = blocker.active("gemini", d.now());
      if (geminiBlock) return unscored(c, "transcription", new GeminiError(geminiBlock.message, 503, null, geminiBlock.reason), audio);
      // 費用がかかる聞き取りの直前で、今日の回数と利用料の上限を数える（声なしの記録は数えない）
      const reserved = reserveDaily(d.db, cfg, "answer", d.now(), usage.todayJpy(), trial.enabled ? answerGate(d.db, trial, userKeyOf(c)) : undefined);
      if (reserved.user) return c.json({ error: answersReachedMessage, reason: "trial_daily_done", trial: trialOf(c), audio: audioSummary(audio) }, 429);
      if (!reserved.ok) return dailyRefusal(c, reserved.limit as DailyLimit, { audio: audioSummary(audio) });
      let heard;
      try { heard = await gemini.transcribeSpeech({ audioBase64, mimeType: "audio/wav" }); }
      catch (error) { noteFailure("gemini", error); return unscored(c, "transcription", error, audio); }
      if (heard.recognitionStatus !== "clear") return c.json({ error: heard.recognitionStatus === "empty" ? "音声を検出できませんでした。もう一度話してください。" : "音声を十分に聞き取れませんでした。もう一度話してください。", reason: heard.recognitionStatus, transcript: heard.transcript, audio: audioSummary(audio) }, 422);
      let grading;
      try { grading = await claude.gradeAnswer(instantQuestionById.get(questionId)!, heard.transcript); }
      catch (error) { noteFailure("claude", error); return unscored(c, "grading", error, audio, { transcript: heard.transcript }); }
      const evaluation = { recognitionStatus: "clear", transcript: heard.transcript, ...grading, transcriptionModel: heard.model };
      const recorded = store.record(sessionId, questionId, expected, evaluation);
      if (!recorded) return c.json(NOT_ANSWERABLE, 409);
      return c.json({ ...recorded, audio: audioSummary(audio) });
    } catch (error) { return instantError(c, error); }
  });

  // ブラウザが「声なし」と判定した区間の、回答なしの記録（音声を送らない・外部 API を呼ばない）
  app.post("/api/instant/no-answer", async (c) => {
    try {
      const { sessionId, questionId, segmentEnd } = await readJsonObject(c, DEFAULT_BODY_LIMIT);
      if (typeof sessionId !== "string" || typeof questionId !== "string" || !instantQuestionById.has(questionId) || !WINDOW_CLOSED.has(segmentEnd as string)) return c.json({ error: "回答なしの指定が正しくありません。" }, 400);
      const store = storeOf(c);
      const expected = store.checkAnswerable(sessionId, questionId);
      if (!expected) return c.json(NOT_ANSWERABLE, 409);
      // お試し：今日の上限を数えるのは記録の直前（check と record の間に await を挟まない）
      if (trial.enabled && answerGate(d.db, trial, userKeyOf(c)).check(jstDate(d.now()))) return c.json({ error: answersReachedMessage, reason: "trial_daily_done", trial: trialOf(c) }, 429);
      const recorded = store.record(sessionId, questionId, expected, noAnswerEvaluation(segmentEnd as string));
      if (!recorded) return c.json(NOT_ANSWERABLE, 409);
      return c.json(recorded);
    } catch (error) { return instantError(c, error); }
  });

  app.post("/api/instant/finish", async (c) => {
    try {
      const { sessionId, reason } = await readJsonObject(c, DEFAULT_BODY_LIMIT);
      if (typeof sessionId !== "string" || !["completed", "stopped"].includes(reason as string)) return c.json({ error: "終了の指定が正しくありません。" }, 400);
      const result = storeOf(c).finish(sessionId, reason as string);
      if (!result) return c.json({ error: "出題を見つけられませんでした。記録がリセットされた可能性があります。画面を更新してください。" }, 404);
      return c.json(result);
    } catch (error) { return instantError(c, error); }
  });
  app.get("/api/usage", (c) => {
    try { return c.json({ ...usage.summary(), daily: daily() }); } catch { return c.json({ error: "利用料の目安を読み込めませんでした。" }, 500); }
  });
  app.get("/api/instant/results/:sessionId", (c) => {
    try {
      const result = storeOf(c).results(c.req.param("sessionId"));
      if (!result) return c.json({ error: "終了した出題を見つけられませんでした。" }, 404);
      return c.json(result);
    } catch (error) { return instantError(c, error); }
  });
  app.get("/api/instant/history", (c) => {
    try { return c.json(storeOf(c).history()); } catch (error) { return instantError(c, error); }
  });
  app.post("/api/instant/speech", async (c) => {
    try {
      const limited = rateRefusal(c, "speech", cfg.rateSpeechPerMinute);
      if (limited) return limited;
      const { questionId, attemptId, kind } = await readJsonObject(c, DEFAULT_BODY_LIMIT);
      if (typeof questionId !== "string" || (attemptId !== undefined && typeof attemptId !== "string") || (kind !== undefined && kind !== "prompt")) return c.json({ error: "読み上げ対象が不正です。" }, 400);
      const speechText = storeOf(c).speechText(questionId, attemptId as string | undefined, kind === "prompt");
      if (!speechText) return c.json({ error: "読み上げる文章を見つけられませんでした。英文は答え合わせ後に再生できます。" }, 404);
      const geminiBlock = blocker.active("gemini", d.now());
      if (geminiBlock) return c.json({ error: geminiBlock.message, reason: "provider_blocked", providerReason: geminiBlock.reason }, 503);
      const reserved = reserveDaily(d.db, cfg, "speech", d.now(), usage.todayJpy(), trial.enabled ? speechGate(d.db, trial, userKeyOf(c)) : undefined);
      if (reserved.user) return c.json({ error: speechDoneMessage, reason: "trial_speech_done", trial: trialOf(c) }, 429);
      if (!reserved.ok) return dailyRefusal(c, reserved.limit as DailyLimit);
      let audio: Uint8Array;
      try { audio = await gemini.synthesizeSpeech(speechText, kind === "prompt" ? "ja" : "en"); }
      catch (error) { noteFailure("gemini", error); throw error; }
      return new Response(audio as unknown as BodyInit, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    } catch (error) { return instantError(c, error); }
  });
  app.post("/api/instant/reset", (c) => {
    try { return c.json(storeOf(c).reset()); } catch (error) { return instantError(c, error); }
  });

  app.notFound((c) => c.json({ error: "見つかりません。", reason: "not_found" }, 404));
  app.onError((error, c) => {
    console.warn("想定外のエラー:", error instanceof Error ? error.message : "不明", error instanceof Error ? error.stack : "");
    return c.json({ error: "サーバーで問題が起きました。", reason: "internal" }, 500);
  });
  return app;
}
