import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { audioSummary, inspectSpeechWav } from "../shared/audio.js";
import { canConvertRecording, convertRecordingToWav } from "./recording.js";
import { RequestError, apiFetch, request } from "./api.js";
import { segmentPlan, type SegmentPlan } from "./lib/segment-plan.js";
import { keyWarning, resetConfirm } from "./strings.js";
import { FINISH_WAIT_HINT_MS, canSkip, correctionToShow, countResults, currentQuestion, initialRun, isMeaningOkBelowPass, isSettled, isTimeUp, mergeResults, nextKeyAction, pendingCount, remainingMs, remainingWholeSeconds, runReducer, type AudioSummary, type Outcome, type RecordedAttempt, type RunEvent, type RunQuestion, type RunState } from "./lib/instant-run.js";
import { PASS_SCORE, QUESTION_COUNT_DEFAULT, QUESTION_COUNT_OPTIONS, QUESTION_SECONDS_DEFAULT, QUESTION_SECONDS_MAX, QUESTION_SECONDS_MIN, QUESTION_SECONDS_PRESETS, parseQuestionCount, parseQuestionSeconds, questionDurationMs, questionSecondsLabel, stepQuestionSeconds, SPEECH_SPEED_DEFAULT, parseSpeechSpeed, type QuestionSeconds, type SpeechSpeed } from "../shared/instant-rules.js";
import { TRIAL_SESSION_SIZE } from "../shared/trial-rules.js";
import { idleMessage, refreshApplies, sessionProgressed, shouldRefresh, type RefreshMarks } from "./lib/refresh-policy.js";
import { createSpeechCache, speechKey } from "./lib/speech-cache.js";
import { endsOnLabel, msUntilJstMidnight, parseTrialInfo, trialBlockedMessage, trialNextCount, trialRemaining, trialSpeechRemaining, type TrialInfo } from "./lib/trial-view.js";
import { TRIAL } from "./strings.js";
import { notifyUsageChanged } from "./usage-events.js";

type Question = { id: string; japanese: string; category: string; referenceAnswer?: string };
type Session = { id: string; total: number; answeredCount: number; questions: RunQuestion[]; pendingQuestionIds: string[] };
type Summary = { generationId: string; total: number; cleared: number; remaining: number; attempts: number; todayAttempts?: number; todayAverage?: number | null; averageScore?: number | null; activeSession: Session | null; geminiConfigured?: boolean; claudeConfigured?: boolean; providerBlock?: { provider: string; message: string } | null };
type Attempt = { id: string; questionId: string; createdAt: string; outcome?: "answered" | "no_answer"; transcript: string; meaningScore: number; grammarScore: number; score: number; passed: boolean; reasonJa: string; grammarFeedbackJa: string; correctedAnswerEn?: string; meaningEquivalent?: boolean; consecutivePasses: number; referenceAnswer?: string };
type Results = { sessionId: string; finishedAt: string; endedReason: "completed" | "stopped"; questionSeconds?: QuestionSeconds | "none"; /* "none" は前の版の記録 */ items: { question: Question; attempt: Attempt | null }[]; summary: Summary };
type History = { progress: { question: Question; consecutivePasses: number; clearedAt: string | null; attempts: Attempt[] }[]; summary: Summary };
type RecordResponse = { attempt: RecordedAttempt; session: Session; completed: boolean; summary: Summary; audio?: AudioSummary };
type SegmentEnd = "timeout" | "next" | "stopped";
// 問題1つにつき録音機を1つ使う。区間ごとに完全な webm になるので、そのまま WAV に変換できる
type Segment = { recorder: MediaRecorder; chunks: BlobPart[]; questionId: string; sessionId: string; runId: number; end: SegmentEnd | null; done: boolean };

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = () => reject(new Error("録音を読み取れませんでした。")); reader.readAsDataURL(blob); });
}
function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || null;
}
// 画面に出してよいのは、サーバーが返した日本語の文言（RequestError）だけ。想定外の例外の英語の文は出さず、決まった文言にする
const scoreText = (value: number | null | undefined) => typeof value === "number" ? `${value.toFixed(1)} 点` : "–"; // 平均点（1件も無ければ –）
function userMessage(error: unknown, fallback: string): string { return error instanceof RequestError ? error.message : fallback; }
function unscoredMessage(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.status === 422) return "聞き取り（Gemini）で音声を聞き取れませんでした。";
    if (error.status === 409) return "この問題は記録できませんでした（記録済み、または出題が終わりました）。";
    if (error.reason === "transcription_failed") return `聞き取り（Gemini）でエラー：${error.message}`;
    if (error.reason === "grading_refused") return "採点（Claude）が断られました。";
    if (error.reason === "grading_failed") return `採点（Claude）でエラー：${error.message}`;
    return error.message;
  }
  return "サーバーに接続できませんでした。";
}
// 状態の更新で、サーバーが返さない「キーの設定の有無」は前の値を引き継ぐ（消えるとスタートが無効になる）
const keepKeyFlags = (next: Summary, previous: Summary | null): Summary => ({ ...next, geminiConfigured: previous?.geminiConfigured, claudeConfigured: previous?.claudeConfigured });
const isActive = (phase: RunState["phase"]) => phase === "mic" || phase === "running" || phase === "paused" || phase === "finishing";
const STOP_TEXT = "停止しました。送った答えの採点がそろったら、答え合わせを表示します。";
const PROGRESSED_TEXT = "別の端末でこの出題が進みました。画面を最新にしました。スタートを押すと、残りがあれば続きから、終わっていれば新しい出題を始めます。";
const SPEECH_USED_UP_TEXT = "今日の読み上げは使い切りました。一度聞いた文はこのページの間は再生できます。";
const SPEECH_SPEED_KEY = "speak25.speechSpeed";
const SPEECH_SPEED_LABEL: Record<SpeechSpeed, string> = { normal: "普通", slow: "ゆっくり" };
const readSpeechSpeed = (): SpeechSpeed => { try { return parseSpeechSpeed(localStorage.getItem(SPEECH_SPEED_KEY)) ?? SPEECH_SPEED_DEFAULT; } catch { return SPEECH_SPEED_DEFAULT; } };
const PAUSE_TEXT = "一時停止中です。録音と時間を止めています。「再開」で同じ問題の続きから始めます。";

export default function InstantPractice({ onActiveChange, onMode, onTrial }: { onActiveChange?: (active: boolean) => void; onMode?: (mode: "solo" | "trial" | "trial-name") => void; onTrial?: (trial: TrialInfo | null) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [run, setRun] = useState<RunState>(initialRun);
  const [clock, setClock] = useState(0); // 残り時間の表示を更新するためだけの値
  const [results, setResults] = useState<Results | null>(null);
  const [showGiveUp, setShowGiveUp] = useState(false);
  const [finalizeFailed, setFinalizeFailed] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [message, setMessageRaw] = useState("学習記録を読み込んでいます。");
  const [trial, setTrial] = useState<TrialInfo | null>(null); // お試しモードのときだけ入る（1人用は null のまま）
  const trialRef = useRef<TrialInfo | null>(null); // 古い closure から読むので正は ref
  const trialLoading = useRef(false); const trialAgain = useRef(false);
  const speechCache = useRef(createSpeechCache()); // 読み上げの音声を、このページの間だけ覚える（同じ文は API を呼ばない）
  const historySection = useRef<HTMLElement | null>(null); // 履歴は答え合わせの下に開くので、開いたらここまでスクロールする
  const [busy, setBusy] = useState(false);
  const [speechSpeed, setSpeechSpeed] = useState<SpeechSpeed>(readSpeechSpeed); // 読み上げの速さ。端末ごとに localStorage で覚える（サーバーの表には持たない）
  const [playing, setPlaying] = useState<string | null>(null);
  const [playNote, setPlayNote] = useState<{ key: string; text: string } | null>(null); // 読み上げが断られたときの文を、押したボタンの横に出す
  const [resuming, setResuming] = useState(false); const resumingRef = useRef(false); // 再開の前に status を確かめている間
  const runRef = useRef<RunState>(initialRun()); // 正はこちら。描画用に setRun で写す
  const runId = useRef(0); // 実行ごとに1増やす。遅れて届く処理はこれで捨てる
  const stream = useRef<MediaStream | null>(null);
  const segment = useRef<Segment | null>(null); // 今録音している区間
  const mimeType = useRef("");
  const ticker = useRef<number | null>(null);
  const finalizing = useRef(false);
  const stopNote = useRef(""); // 停止の理由に合わせた、答え合わせを出すときの文言
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const mounted = useRef(true);
  const resetVersion = useRef(0);
  const speechSeq = useRef(0); // 読み上げの速さを切り替えるたびに1増やす。古い速さの要求の結果はこれで捨てる（state でなく ref を読む）
  const [questionSeconds, setQuestionSeconds] = useState<QuestionSeconds>(QUESTION_SECONDS_DEFAULT);
  const [questionCount, setQuestionCount] = useState<number>(QUESTION_COUNT_DEFAULT);
  const [settingsReady, setSettingsReady] = useState(false); // 読み込みが終わる（失敗を含む）までは欄を出さず、スタートも押せない
  const [settingsNote, setSettingsNote] = useState<"" | "load" | "save">(""); // 失敗の種類だけ持ち、文は描くときに trial を見て決める（status より先に失敗が返ってもお試しの文になる）
  const helpDialog = useRef<HTMLDialogElement | null>(null); // 「使い方」のモーダル
  const wantedSeconds = useRef<QuestionSeconds>(QUESTION_SECONDS_DEFAULT); // 古い closure から読むので正は ref
  const wantedCount = useRef<number>(QUESTION_COUNT_DEFAULT);
  const saving = useRef(false); const saveAgain = useRef(false);
  const lastStatusAt = useRef<number | null>(null); // 最後に状態を読み直した時刻
  const statusLoading = useRef(false); const statusAgain = useRef(false);
  const resultsRef = useRef<Results | null>(null); const busyRef = useRef(false); const resetting = useRef(false);

  const msgSeq = useRef(0); const saveSeq = useRef(0); // 文・設定の保存の通し番号（読み直しの応答が、その間の変更を上書きしないため）
  const setMessage = (text: string) => { msgSeq.current += 1; setMessageRaw(text); }; // 読み直し以外で文を変えるときは番号を進める
  const marks = (): RefreshMarks => ({ message: msgSeq.current, run: runId.current, reset: resetVersion.current, save: saveSeq.current });
  const applyTrial = (value: TrialInfo | null) => { trialRef.current = value; if (mounted.current) { setTrial(value); onTrial?.(value); } };
  // お試しのときだけ、今日の残りなどを読み直す。同時には1つだけ（読み込み中に頼まれたら、終わった後に1回だけ）
  const refreshTrial = async () => {
    if (!trialRef.current) return;
    if (trialLoading.current) { trialAgain.current = true; return; }
    trialLoading.current = true;
    try {
      const value = parseTrialInfo((await request<{ trial?: unknown }>("/api/trial/me")).trial);
      if (value && mounted.current) applyTrial(value);
    } catch { /* 読めなくても、次の機会に読み直す */ }
    finally { trialLoading.current = false; if (trialAgain.current && mounted.current) { trialAgain.current = false; void refreshTrial(); } }
  };

  // 別の端末で出題が進んでいたとき、この端末の一時停止中の出題を捨てて待機に戻す（区間は送らない。録音機のハンドラを先に外すので、onstop からの送信は起きない）
  const returnToIdle = (value: Summary, info: TrialInfo | null) => {
    const seg = segment.current; segment.current = null; stopTicker();
    if (seg) { seg.done = true; seg.recorder.ondataavailable = null; seg.recorder.onstop = null; seg.recorder.onerror = null; if (seg.recorder.state !== "inactive") { try { seg.recorder.stop(); } catch { /* 止められなくてもトラックを止める */ } } }
    releaseMic(); runId.current += 1; commit({ type: "abort" });
    setSummary(value); if (info) applyTrial(info);
    setMessage(PROGRESSED_TEXT);
  };

  // 戻ったときの読み直し（1人用・お試し共通）。状態と設定を読み直す。同時には1つだけ（読み込み中に頼まれたら、終わった後に1回だけ）
  const refreshStatus = async () => {
    const phase = runRef.current.phase;
    if (phase !== "idle" && phase !== "done" && phase !== "paused") return; // 録音中・採点待ちは読まない
    if (busyRef.current || resetting.current) return;
    if (statusLoading.current) { statusAgain.current = true; return; }
    statusLoading.current = true;
    const start = marks();
    try {
      const value = await request<Summary>("/api/instant/status");
      if (!mounted.current) return;
      lastStatusAt.current = Date.now();
      const nowPhase = runRef.current.phase;
      if (nowPhase !== "idle" && nowPhase !== "done" && nowPhase !== "paused") return; // 読んでいる間に出題が始まった
      const apply = refreshApplies(start, marks(), { saving: saving.current || saveAgain.current });
      if (!apply.summary) return; // 読んでいる間に、出題・リセットがあった
      const info = parseTrialInfo((value as { trial?: unknown }).trial);
      if (nowPhase === "paused" && sessionProgressed(runRef.current, value.activeSession)) { returnToIdle(value, info ?? trialRef.current); return; } // 別の端末で進んだ出題は、その場で待機に戻す
      setSummary(value);
      if (info) applyTrial(info);
      // 答え合わせを見ている途中・読んでいる間に変わった文（スタートの失敗など）は消さない
      if (nowPhase === "idle" && !resultsRef.current && apply.message) setMessageRaw(idleMessage(value, info ?? trialRef.current));
      if (nowPhase !== "paused" && !saving.current && !saveAgain.current) {
        const settings = await request<{ questionSeconds?: unknown; questionCount?: unknown }>("/api/instant/settings");
        if (!mounted.current || isActive(runRef.current.phase) || !refreshApplies(start, marks(), { saving: saving.current || saveAgain.current }).settings) return;
        const seconds = parseQuestionSeconds(settings.questionSeconds); const count = parseQuestionCount(settings.questionCount);
        if (seconds !== undefined) { wantedSeconds.current = seconds; setQuestionSeconds(seconds); }
        if (count !== undefined) { wantedCount.current = count; setQuestionCount(count); }
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof RequestError && error.status === 401) { location.replace("/login"); return; }
      if (error instanceof RequestError && error.reason === "trial_name_required") onMode?.("trial-name");
      // それ以外は読めなくても、次の機会に読み直す
    } finally { statusLoading.current = false; if (statusAgain.current && mounted.current) { statusAgain.current = false; void refreshStatus(); } }
  };

  const commit = (event: RunEvent) => { runRef.current = runReducer(runRef.current, event); setRun(runRef.current); };

  // 注意：ticker・録音機のイベント・送信の後の処理は、古い描画の closure から呼ばれる。
  // だから summary や run などの state は読まず、ref だけを読む。更新は setSummary((previous) => ...) の関数の形で行う。
  const stopTicker = () => { if (ticker.current !== null) { window.clearInterval(ticker.current); ticker.current = null; } };
  const releaseMic = () => { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; };
  // 録音中の区間が無く、実行中でも一時停止中でもなければマイクを離す
  const releaseMicIfIdle = () => { const phase = runRef.current.phase; if (!segment.current && phase !== "running" && phase !== "paused") releaseMic(); };
  const stopSpeech = () => { audio.current?.pause(); if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; } setPlaying(null); };

  const openSegment = (media: MediaStream, questionId: string, sessionId: string, id: number): Segment => {
    const recorder = new MediaRecorder(media, { mimeType: mimeType.current });
    const seg: Segment = { recorder, chunks: [], questionId, sessionId, runId: id, end: null, done: false };
    recorder.ondataavailable = (event) => { if (event.data.size) seg.chunks.push(event.data); };
    recorder.onstop = () => { void finishSegment(seg); };
    recorder.onerror = () => handleMicLost(id);
    return seg;
  };
  const closeSegment = (seg: Segment, end: SegmentEnd) => {
    seg.end = end;
    if (seg.recorder.state !== "inactive") { try { seg.recorder.stop(); } catch { void finishSegment(seg); } }
    else void finishSegment(seg);
  };

  const resolveOutcome = (seg: Segment, outcome: Exclude<Outcome, { kind: "pending" }>) => {
    if (seg.runId !== runId.current || !mounted.current) return;
    commit({ type: "outcome", questionId: seg.questionId, outcome });
    maybeFinalize();
  };
  const maybeFinalize = () => { if (isSettled(runRef.current)) void finalizeRun(); };

  const finishSegment = async (seg: Segment) => {
    if (seg.done) return;
    seg.done = true;
    if (seg.runId !== runId.current || !mounted.current) return;
    if (seg.end === null) { seg.end = "stopped"; if (segment.current === seg) handleMicLost(seg.runId); } // 自分で止めていないのに止まった
    const end = seg.end;
    releaseMicIfIdle();
    const blob = new Blob(seg.chunks, { type: seg.recorder.mimeType || mimeType.current });
    const notUsable = (text: string) => resolveOutcome(seg, end !== "stopped" ? { kind: "unscored", message: text } : { kind: "skipped" });
    if (blob.size < 800) return notUsable("録音を取り出せませんでした。");
    let wav: Blob;
    let bytes: Uint8Array;
    try {
      const converted = await convertRecordingToWav(blob);
      if (seg.runId !== runId.current || !mounted.current) return;
      if (converted.durationSec < 0.3) return notUsable("録音が短すぎました。");
      wav = converted.blob;
      bytes = converted.bytes;
    } catch { return resolveOutcome(seg, { kind: "unscored", message: "録音を採点用の形式に変換できませんでした。" }); }
    // ブラウザでも声の有無を判定する（サーバーと同じ関数）。声が無い区間は、録音を送らずに済ませる（サーバーと同じ判定を画面側でも使う）
    let local: AudioSummary | undefined;
    let plan: SegmentPlan = "upload";
    try { const inspected = inspectSpeechWav(bytes); local = audioSummary(inspected); plan = segmentPlan(end, inspected.detection); } catch { plan = "upload"; local = undefined; }
    if (plan === "skip") return resolveOutcome(seg, { kind: "skipped" });
    if (plan === "no_answer" && end !== "stopped") return submitNoAnswer(seg, end, local);
    await submitSegment(seg, wav, end);
  };

  // 答えの記録に失敗したときの扱い（送った場合も、声なしの記録の場合も同じ）
  const resolveSubmitError = (seg: Segment, error: unknown) => {
    // 1日の上限・月の上限・残高切れは、画面の上の案内にも出す（未採点の行だけだと気づきにくい）
    if (error instanceof RequestError && (error.reason === "daily_limit" || error.reason === "trial_daily_done" || error.providerReason === "spend_limit" || error.providerReason === "billing") && seg.runId === runId.current && mounted.current) setMessage(error.message);
    if (error instanceof RequestError && error.reason === "trial_daily_done") void refreshTrial();
    if (error instanceof RequestError && error.status === 422 && error.reason === "no_speech") resolveOutcome(seg, { kind: "skipped" }); // 停止の区間で声なし
    else resolveOutcome(seg, { kind: "unscored", message: unscoredMessage(error), transcript: error instanceof RequestError && (error.reason === "grading_failed" || error.reason === "grading_refused") ? error.transcript : undefined });
  };

  // ブラウザが「声なし」と判定した区間：音声を送らず、回答なしの記録だけを頼む（費用はかからない）
  const submitNoAnswer = async (seg: Segment, end: "timeout" | "next", local?: AudioSummary) => {
    try {
      const value = await request<RecordResponse>("/api/instant/no-answer", { sessionId: seg.sessionId, questionId: seg.questionId, segmentEnd: end });
      if (seg.runId !== runId.current || !mounted.current) return;
      setSummary((previous) => previous && previous.generationId === value.summary.generationId && previous.attempts > value.summary.attempts ? previous : keepKeyFlags(value.summary, previous));
      resolveOutcome(seg, { kind: "recorded", attempt: value.attempt, audio: local });
      void refreshTrial();
    } catch (error) { resolveSubmitError(seg, error); }
  };

  const submitSegment = async (seg: Segment, wav: Blob, end: SegmentEnd) => {
    try {
      const value = await request<RecordResponse>("/api/instant/answer", { sessionId: seg.sessionId, questionId: seg.questionId, mimeType: "audio/wav", audioBase64: await dataUrl(wav), segmentEnd: end });
      if (seg.runId !== runId.current || !mounted.current) return;
      // 答えは順番が前後して返るので、回答の件数が減る向きには戻さない
      setSummary((previous) => previous && previous.generationId === value.summary.generationId && previous.attempts > value.summary.attempts ? previous : keepKeyFlags(value.summary, previous));
      resolveOutcome(seg, { kind: "recorded", attempt: value.attempt, audio: value.audio });
    } catch (error) { resolveSubmitError(seg, error);
    } finally { notifyUsageChanged(); void refreshTrial(); }
  };

  const finalizeRun = async () => {
    if (finalizing.current) return;
    const state = runRef.current;
    if (!state.sessionId) return;
    finalizing.current = true;
    const id = runId.current; const version = resetVersion.current;
    setFinalizeFailed(false);
    try {
      const value = await request<Results>("/api/instant/finish", { sessionId: state.sessionId, reason: state.stopReason ?? "stopped" });
      if (!mounted.current || id !== runId.current || version !== resetVersion.current) return;
      setResults(value); setSummary((previous) => (keepKeyFlags(value.summary, previous)));
      commit({ type: "done" });
      void refreshTrial();
      releaseMic(); // 録音機の onstop が来ずにマイクが残ることを防ぐ
      setMessage(value.endedReason === "stopped" ? (stopNote.current || "停止しました。答えた分の答え合わせを表示しています。") : "答え合わせを表示しています。");
    } catch (error) {
      if (!mounted.current || id !== runId.current) return;
      if (error instanceof RequestError && error.status === 404) { commit({ type: "abort" }); setMessage(error.message); return; }
      finalizing.current = false; setFinalizeFailed(true); setMessage(userMessage(error, "答え合わせを読み込めませんでした。"));
    }
  };
  const giveUp = () => { commit({ type: "give_up" }); maybeFinalize(); };

  // 今の問題を締めて次へ進む（0秒＝timeout、Tab・「次へ」＝next）。次の録音を先に始めてから、前の録音を止める
  const advanceQuestion = (end: "timeout" | "next") => {
    const state = runRef.current;
    if (state.phase !== "running" || !state.countdown) return;
    const now = performance.now(); setClock(now);
    const next = state.questions[state.position + 1];
    const old = segment.current; segment.current = null;
    let failed = Boolean(next); // 次の録音を始められたら false にする
    if (next && stream.current) {
      try { const seg = openSegment(stream.current, next.id, state.sessionId!, runId.current); seg.recorder.start(); segment.current = seg; failed = false; } // 次を先に始める
      catch { failed = true; }
    }
    commit({ type: "advance", now }); // 今の問題を「送信待ち」にする
    if (old) closeSegment(old, end); // その後で前の区間を止める
    if (!next) { stopTicker(); maybeFinalize(); } // マイクは最後の区間の onstop で離す
    else if (failed) {
      stopTicker(); commit({ type: "stop", segmentSent: false });
      setMessage("録音を続けられなくなったため停止しました。答えた分の答え合わせを表示します。");
      stopNote.current = "録音を続けられなくなったため停止しました。答えた分の答え合わせを表示しています。";
      if (!old) releaseMic(); // 前の区間があるときは、その onstop（finishSegment）が離す（最後の音を取りこぼさないため）
      maybeFinalize();
    }
  };
  const onTick = () => {
    const state = runRef.current;
    if (state.phase !== "running" || !state.countdown) return;
    const now = performance.now(); setClock(now);
    if (!isTimeUp(state.countdown, now)) return;
    advanceQuestion("timeout");
  };
  const skipToNext = () => { if (canSkip(runRef.current, performance.now())) advanceQuestion("next"); };

  const pauseRun = (text = PAUSE_TEXT) => {
    if (runRef.current.phase !== "running") return;
    const seg = segment.current;
    if (seg?.recorder.state === "recording") { try { seg.recorder.pause(); } catch { stopRunWith("録音を止められなかったため停止しました。答えた分の答え合わせを表示します。"); return; } }
    const now = performance.now();
    commit({ type: "pause", now }); setClock(now); setMessage(text);
  };
  const resumeRun = async () => {
    if (runRef.current.phase !== "paused" || resumingRef.current) return;
    resumingRef.current = true; setResuming(true);
    try {
      const id = runId.current;
      let value: Summary | null = null;
      try { value = await request<Summary>("/api/instant/status"); }
      catch (error) {
        if (!mounted.current) return;
        if (error instanceof RequestError && error.status === 401) { location.replace("/login"); return; }
        if (error instanceof RequestError && error.reason === "trial_name_required") { onMode?.("trial-name"); return; }
        // それ以外は読めなくても今までどおり再開する（サーバーが 409 で守る）
      }
      if (!mounted.current || id !== runId.current || runRef.current.phase !== "paused") return; // 読んでいる間に停止・リセットされた
      if (value && sessionProgressed(runRef.current, value.activeSession)) { returnToIdle(value, parseTrialInfo((value as { trial?: unknown }).trial) ?? trialRef.current); return; }
      if (document.visibilityState === "hidden") { setMessage("画面が裏に回ったため一時停止しました。「再開」で続けます。"); return; } // 確認を待つ間に裏へ回ったら、裏のまま走らせない
      doResume();
    } finally { resumingRef.current = false; if (mounted.current) setResuming(false); }
  };
  const doResume = () => {
    const seg = segment.current;
    if (seg?.recorder.state === "paused") { try { seg.recorder.resume(); } catch { stopRunWith("録音を再開できなかったため停止しました。答えた分の答え合わせを表示します。"); return; } }
    const now = performance.now();
    commit({ type: "resume", now }); setClock(now); setMessage("");
  };
  // 停止ボタン・マイクの切断で共通
  const stopRunWith = (text: string) => {
    const phase = runRef.current.phase;
    if (phase !== "running" && phase !== "paused") return;
    const seg = segment.current; segment.current = null; stopTicker();
    commit({ type: "stop", segmentSent: Boolean(seg) }); setMessage(text);
    stopNote.current = text === STOP_TEXT ? "" : text.replace(/表示します。$/, "表示しています。");
    if (seg) closeSegment(seg, "stopped"); else releaseMic();
    maybeFinalize();
  };
  const handleMicLost = (id: number) => {
    if (id !== runId.current) return;
    stopRunWith("マイクが使えなくなったため停止しました。答えた分の答え合わせを表示します。");
  };

  // 保存は同時に1つだけ。保存中にまた変わったら、終わった後に最新の値で1回だけ保存し直す（順番が入れ替わって古い値が残るのを防ぐ）
  const saveSettings = async () => {
    saveSeq.current += 1;
    if (saving.current) { saveAgain.current = true; return; }
    saving.current = true;
    try { await request("/api/instant/settings", { questionSeconds: wantedSeconds.current, questionCount: wantedCount.current }, "PUT"); if (mounted.current) setSettingsNote(""); }
    catch { if (mounted.current) setSettingsNote("save"); }
    finally { saving.current = false; if (saveAgain.current && mounted.current) { saveAgain.current = false; void saveSettings(); } }
  };
  const chooseQuestionSeconds = (value: QuestionSeconds) => {
    if (isActive(runRef.current.phase) || value === wantedSeconds.current) return;
    wantedSeconds.current = value; setQuestionSeconds(value); void saveSettings();
  };
  const chooseQuestionCount = (value: number) => {
    if (isActive(runRef.current.phase) || value === wantedCount.current) return;
    wantedCount.current = value; setQuestionCount(value); void saveSettings();
  };
  // 数字の欄（role="spinbutton"）：↑↓で1秒、PageUp/PageDown で5秒、Home/End で10秒/30秒。ほかのキー（Tab など）は何もしない
  const onTimeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const current = wantedSeconds.current;
    const next = event.key === "ArrowUp" ? stepQuestionSeconds(current, 1) : event.key === "ArrowDown" ? stepQuestionSeconds(current, -1)
      : event.key === "PageUp" ? stepQuestionSeconds(current, 5) : event.key === "PageDown" ? stepQuestionSeconds(current, -5)
      : event.key === "Home" ? QUESTION_SECONDS_MIN : event.key === "End" ? QUESTION_SECONDS_MAX : undefined;
    if (next === undefined) return;
    event.preventDefault();
    chooseQuestionSeconds(next);
  };

  const startRun = async () => {
    if (isActive(runRef.current.phase) || busy) return;
    const limit = wantedSeconds.current; const count = trialRef.current ? TRIAL_SESSION_SIZE : wantedCount.current; // お試しは1回10問
    const type = recordingType();
    setMessage("");
    if (!type || !navigator.mediaDevices?.getUserMedia) { setMessage("このブラウザでは録音できません。ChromeまたはSafariの新しい版で、localhostかHTTPSから開いてください。"); return; }
    if (!canConvertRecording()) { setMessage("このブラウザでは録音を採点用の形式（WAV）に変換できません。最新のChromeで開いてください。"); return; }
    // 日本語の読み上げがマイクに入って声と判定されないよう、再生中の音声を止めてから録音する。段階は await の前に同期で変える（二度押しを止める）
    stopSpeech();
    setPlayNote(null);
    const id = ++runId.current; const version = resetVersion.current;
    finalizing.current = false; stopNote.current = ""; setFinalizeFailed(false);
    commit({ type: "request_mic" }); setResults(null); setShowHistory(false);
    setMessage("マイクの許可を待っています。");
    const abort = (text: string) => { if (id === runId.current && mounted.current) { commit({ type: "abort" }); setMessage(text); } };
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      abort(name === "NotAllowedError" ? "マイクの使用が許可されていません。アドレス欄の左のアイコンからマイクを許可してから、もう一度スタートしてください。" : name === "NotFoundError" ? "マイクが見つかりません。マイクをつないでから、もう一度スタートしてください。" : "マイクを使用できませんでした。ブラウザのマイク権限を確認してください。");
      return;
    }
    const stale = () => !mounted.current || id !== runId.current || version !== resetVersion.current;
    if (stale()) { media.getTracks().forEach((track) => track.stop()); return; }
    let session: Session | null;
    let resumed = false;
    try {
      const value = await request<Summary & { session: Session | null; resumed?: boolean }>("/api/instant/start", { generationId: summary?.generationId, questionSeconds: limit, questionCount: count });
      if (stale()) { media.getTracks().forEach((track) => track.stop()); return; }
      setSummary((previous) => (keepKeyFlags(value, previous)));
      const startInfo = parseTrialInfo((value as { trial?: unknown }).trial);
      if (startInfo) applyTrial(startInfo);
      session = value.session;
      resumed = value.resumed === true;
    } catch (error) {
      media.getTracks().forEach((track) => track.stop());
      if (error instanceof RequestError && (error.reason === "trial_daily_done" || error.reason === "trial_closed")) void refreshTrial();
      abort(userMessage(error, "出題を開始できませんでした。ページを再読み込みしてから、もう一度スタートしてください。"));
      return;
    }
    if (!session) { media.getTracks().forEach((track) => track.stop()); abort("100問すべてクリアしました。もう一度練習するには記録をリセットしてください。"); return; }
    try {
      const pending = new Set(session.pendingQuestionIds);
      const queue = session.questions.filter((question) => pending.has(question.id));
      if (!queue.length) { // ふつうは起きない。終わらせておかないと、同じ出題がずっと残る
        media.getTracks().forEach((track) => track.stop());
        try {
          const finished = await request<Results>("/api/instant/finish", { sessionId: session.id, reason: "completed" });
          if (stale()) return;
          setResults(finished); setSummary((previous) => (keepKeyFlags(finished.summary, previous)));
          commit({ type: "abort" }); setMessage("答え合わせを表示しています。");
        } catch (error) { abort(userMessage(error, "出題を開始できませんでした。ページを再読み込みしてから、もう一度スタートしてください。")); }
        return;
      }
      releaseMic(); // 前の実行のマイクが残っていても必ず離す（二重に呼んでも安全）
      stream.current = media; mimeType.current = type;
      media.getAudioTracks().forEach((track) => track.addEventListener("ended", () => handleMicLost(id)));
      try { const seg = openSegment(media, queue[0].id, session.id, id); seg.recorder.start(); segment.current = seg; }
      catch { releaseMic(); abort("録音を始められませんでした。ページを再読み込みしてから、もう一度スタートしてください。"); return; }
      const now = performance.now();
      commit({ type: "begin", sessionId: session.id, questions: queue, now, durationMs: questionDurationMs(limit) }); setClock(now);
      setMessage(resumed ? `前回の出題の続きから始めました（まだ答えていない${queue.length}問）。` : session.total < count ? (trialRef.current && session.total === trialRemaining(trialRef.current) ? `今日のお試しの残りが${session.total}問なので、${session.total}問出します。` : `まだクリアしていない問題が${session.total}問なので、${session.total}問出します。`) : "");
      ticker.current = window.setInterval(onTick, 200);
      // マイクの許可を待つ間に画面が裏に回っていたら、裏のまま走らせない
      if (document.visibilityState === "hidden") pauseRun("画面が裏に回ったため一時停止しました。「再開」で続けます。");
    } catch (error) {
      // 予期しない例外でも「マイク待ち」で固まらないよう、後片付けをして待機に戻す
      stopTicker(); segment.current = null; releaseMic(); media.getTracks().forEach((track) => track.stop());
      abort(userMessage(error, "出題を開始できませんでした。ページを再読み込みしてから、もう一度スタートしてください。"));
    }
  };

  useEffect(() => {
    mounted.current = true;
    void request<Summary>("/api/instant/status").then((value) => {
      if (!mounted.current) return;
      setSummary(value);
      const info = parseTrialInfo((value as { trial?: unknown }).trial);
      if (info) { onMode?.("trial"); applyTrial(info); } else onMode?.("solo");
      setMessage(idleMessage(value, info));
      lastStatusAt.current = Date.now();
    }).catch((error) => {
      if (error instanceof RequestError && error.reason === "trial_name_required") { onMode?.("trial-name"); return; } // お試し：名前の登録がまだ

      if (error instanceof RequestError && error.status === 401) { location.replace("/login"); return; } // 期限切れ・合言葉の変更：ログイン画面へ
      setMessage(userMessage(error, "学習記録を読み込めませんでした。ページを再読み込みしてください。"));
    });
    void request<{ questionSeconds?: unknown; questionCount?: unknown }>("/api/instant/settings").then((value) => {
      if (!mounted.current) return;
      const seconds = parseQuestionSeconds(value.questionSeconds); const count = parseQuestionCount(value.questionCount);
      if (seconds !== undefined) { wantedSeconds.current = seconds; setQuestionSeconds(seconds); }
      if (count !== undefined) { wantedCount.current = count; setQuestionCount(count); }
    }).catch((error) => { if (mounted.current && !(error instanceof RequestError && error.reason === "trial_name_required")) setSettingsNote("load"); })
      .finally(() => { if (mounted.current) setSettingsReady(true); });
    return () => {
      mounted.current = false; runId.current += 1; stopTicker();
      const seg = segment.current; segment.current = null;
      if (seg) { seg.recorder.ondataavailable = null; seg.recorder.onstop = null; seg.recorder.onerror = null; if (seg.recorder.state !== "inactive") { try { seg.recorder.stop(); } catch { /* 止められなくてもトラックを止める */ } } }
      stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
      audio.current?.pause(); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      onActiveChange?.(false);
    };
  }, []);

  // 実行中の Tab で次の問題へ進む。ref だけを読むので、最初の描画の closure でよい（ticker と同じ考え）。
  // 一時停止中・Shift+Tab・実行中でない画面では何もしない（ふつうのフォーカス移動のまま）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = nextKeyAction(runRef.current, event, performance.now());
      if (action === "ignore") return;
      event.preventDefault(); // 実行中の Tab はフォーカス移動に使わない
      if (action === "skip") advanceQuestion("next");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 画面が裏に回ったら一時停止する（裏のタブではタイマーが間引かれるため）。戻っても自動では再開しない
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden" && runRef.current.phase === "running") pauseRun("画面が裏に回ったため一時停止しました。「再開」で続けます。"); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, []);

  useEffect(() => { onActiveChange?.(isActive(run.phase)); }, [run.phase]);

  busyRef.current = busy; resultsRef.current = results;
  // 戻ったときの読み直し：画面が見えるようになった・ページが復元された時は必ず、ウィンドウにフォーカスが戻った時は15秒以上、開きっぱなしで久しぶりの最初の操作は60秒以上たっていれば。定期的な読み直しはしない
  useEffect(() => {
    const due = (minMs: number) => shouldRefresh(lastStatusAt.current, Date.now(), minMs);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshStatus(); };
    const onPageShow = () => { void refreshStatus(); };
    const onFocus = () => { if (due(15_000)) void refreshStatus(); };
    const onInput = () => { if (due(60_000)) void refreshStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
    };
  }, []);
  const stoppedToday = trial !== null && !trial.closed && trialBlockedMessage(trial) !== null;
  useEffect(() => {
    if (!stoppedToday) return;
    const id = window.setTimeout(() => void refreshTrial(), msUntilJstMidnight(Date.now()) + 2000);
    return () => window.clearTimeout(id);
  }, [stoppedToday]);

  // 回答履歴を開いたら、履歴の位置までスクロールする（答え合わせが長いと、画面の外に開いて「開かない」ように見えるため）
  useEffect(() => {
    if (!showHistory) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    historySection.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [showHistory]);

  // 採点待ちが長引いたときの逃げ道を、一定時間の後に出す
  useEffect(() => {
    setShowGiveUp(false);
    if (run.phase !== "finishing") return;
    const id = window.setTimeout(() => setShowGiveUp(true), FINISH_WAIT_HINT_MS);
    return () => window.clearTimeout(id);
  }, [run.phase]);

  const reset = async () => {
    if (isActive(runRef.current.phase)) return;
    if (!window.confirm(resetConfirm(Boolean(trialRef.current)))) return; // 押しただけで消えないよう、一度確かめる
    resetVersion.current += 1;
    stopSpeech(); setPlayNote(null); setBusy(true); resetting.current = true;
    try { const value = await request<Summary>("/api/instant/reset", {}); setSummary((previous) => (keepKeyFlags(value, previous))); commit({ type: "abort" }); setResults(null); setHistory(null); setShowHistory(false); speechCache.current.clear(); setMessage(`瞬間英作文の記録をすべてリセットしました。100問からやり直せます（${trialRef.current ? "1問の時間" : "1問の時間と問題数"}の設定はそのままです）。${trialRef.current ? TRIAL.resetNote : ""}`); void refreshTrial(); }
    catch (error) { setMessage(userMessage(error, "リセットできませんでした。")); }
    finally { setBusy(false); resetting.current = false; }
  };
  const loadHistory = async () => {
    if (showHistory) { setShowHistory(false); return; }
    const version = resetVersion.current;
    try { const value = await request<History>("/api/instant/history"); if (version === resetVersion.current) { setHistory(value); setShowHistory(true); } }
    catch (error) { if (version === resetVersion.current) setMessage(userMessage(error, "履歴を読み込めませんでした。")); }
  };
  const chooseSpeechSpeed = (speed: SpeechSpeed) => {
    if (speed === speechSpeed) return; // 同じ速さなら何もしない（鳴っている音声も止めない）
    speechSeq.current += 1;
    setSpeechSpeed(speed);
    try { localStorage.setItem(SPEECH_SPEED_KEY, speed); } catch { /* 保存できなくても、この画面の間は選んだ速さで話す */ }
    stopSpeech(); setPlayNote(null); // 再生中に切り替えても、表示が前の速さのままにならない
  };
  const play = async (questionId: string, attemptId?: string) => {
    if (isActive(runRef.current.phase)) return; // 実行中は読み上げを使わない（マイクに入るため）
    const speed = speechSpeed; // ボタンは描画ごとに作り直すので、押した時点の速さ
    const key = speechKey(questionId, attemptId, speed);
    const version = resetVersion.current; const playRun = runId.current; const seq = speechSeq.current;
    setPlaying(key); setPlayNote(null);
    let called = false; // 本当に API を呼んだときだけ、利用料の帯とお試しの残りを読み直す
    try {
      let blob = speechCache.current.get(key); // 一度聞いた文は、API を呼ばずに鳴らす
      if (!blob) {
        called = true;
        const response = await apiFetch("/api/instant/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionId, attemptId, speed }) });
        if (!response.ok) { const value = await response.json().catch(() => ({})); throw new RequestError(value.error || "再生できませんでした。", response.status, typeof value.reason === "string" ? value.reason : undefined); }
        blob = await response.blob();
        if (version !== resetVersion.current) return;
        speechCache.current.set(key, blob);
      }
      if (seq !== speechSeq.current) return; // 待っている間に速さを切り替えた（表示は切り替え側が直している）
      // 生成している間に実行が始まったなら、録音に入らないよう再生しない
      if (isActive(runRef.current.phase)) { setPlaying(null); return; }
      const url = URL.createObjectURL(blob);
      audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = url;
      const player = new Audio(url); audio.current = player;
      player.onended = () => { if (audioUrl.current === url) { URL.revokeObjectURL(url); audioUrl.current = null; } setPlaying(null); };
      player.onerror = () => { if (audioUrl.current === url) { URL.revokeObjectURL(url); audioUrl.current = null; } setPlaying(null); setMessage("音声を再生できませんでした。"); };
      await player.play();
    } catch (error) { if (version === resetVersion.current && seq === speechSeq.current) { setPlaying(null); if (playRun === runId.current && !isActive(runRef.current.phase)) { const text = userMessage(error, "音声を再生できませんでした。"); setMessage(text); setPlayNote({ key, text }); } } }
    finally { if (called) { notifyUsageChanged(); void refreshTrial(); } }
  };

  const playButton = (questionId: string, attemptId?: string) => {
    const key = speechKey(questionId, attemptId, speechSpeed);
    return <><button className="quiet" disabled={Boolean(playing) || active} onClick={() => void play(questionId, attemptId)}>{playing === key ? "生成・再生中" : "▶ 再生"}</button>{playNote?.key === key && <span className="note play-note" role="status"> {playNote.text}</span>}</>;
  };
  const speechUsedUp = Boolean(trial) && trialSpeechRemaining(trial!) === 0;

  const settingsNoteText = settingsNote === "save"
    ? (trial ? "1問の時間を保存できませんでした。今回は選んだ設定で練習できますが、次に開いたときは前の設定に戻ることがあります。" : "1問の時間と問題数を保存できませんでした。今回は選んだ設定で練習できますが、次に開いたときは前の設定に戻ることがあります。")
    : settingsNote === "load"
      ? (trial ? "1問の時間の設定を読み込めませんでした。10秒で始めます（選び直すと保存を試みます）。" : "1問の時間と問題数の設定を読み込めませんでした。10秒・10問で始めます（選び直すと保存を試みます）。")
      : "";
  const active = isActive(run.phase);
  const question = currentQuestion(run);
  const rows = results ? mergeResults(results.items, run.outcomes) : [];
  const counts = countResults(rows);
  const pending = pendingCount(run);
  const trialBlocked = trial ? trialBlockedMessage(trial) : null;
  const startDisabled = busy || !settingsReady || run.phase === "mic" || !summary?.geminiConfigured || !summary?.claudeConfigured || summary.remaining === 0 || trialBlocked !== null;
  const missingKeys = summary ? [!summary.geminiConfigured && "GEMINI_API_KEY（聞き取りと読み上げ）", !summary.claudeConfigured && "ANTHROPIC_API_KEY（採点）"].filter(Boolean) as string[] : [];

  // 説明は1文ずつの箇条書きにする（読みやすさのため。2026-10-21 利用者の依頼）
  const introLines = [
    trial
      ? "お試しは1回10問に固定されています。"
      : "スタート前に「練習の設定」で、1問の時間を10〜30秒、1回の問題数を10・20・30・50問から選べます。",
    "スタートすると録音が始まり、設定した時間がたつと自動で次の問題へ進みます。",
    "答え終わったら「次へ」（PC では Tab キー）で、設定した時間を待たずに次へ進めます。",
  ];
  const timeNote = `${questionSeconds}秒たつと自動で次の問題へ進みます。`;
  const pendingOfActive = summary?.activeSession?.pendingQuestionIds.length ?? 0;
  const countNote = summary?.activeSession ? `前回の出題が途中なので、スタートするとその続き（まだ答えていない${pendingOfActive}問）から始めます。選んだ問題数は、その次の回から使います。`
    : summary && summary.remaining === 0 ? "すべての問題をクリアしています。"
    : summary && summary.remaining < questionCount ? `まだクリアしていない問題が${summary.remaining}問なので、スタートすると${summary.remaining}問出します。`
    : `まだクリアしていない問題から${questionCount}問出します。`;
  const canShorter = stepQuestionSeconds(questionSeconds, -1) !== questionSeconds;
  const canLonger = stepQuestionSeconds(questionSeconds, 1) !== questionSeconds;
  const limitSeconds = run.countdown ? Math.round(run.countdown.durationMs / 1000) : 0;
  const nextCount = trial ? (summary ? trialNextCount(trial, summary.remaining) : TRIAL_SESSION_SIZE) : summary && summary.remaining > 0 ? Math.min(questionCount, summary.remaining) : questionCount;

  return <>
    <section className="instant-overview"><div className="section-title"><div className="title-actions"><button className="quiet" onClick={() => helpDialog.current?.showModal()} disabled={active} aria-haspopup="dialog">使い方</button><button className="quiet" onClick={() => void reset()} disabled={busy || active}>記録をリセット</button></div></div>
      <div className="instant-stats"><span>クリア <strong>{summary?.cleared ?? "–"} / 100</strong></span><span>未クリア <strong>{summary?.remaining ?? "–"}</strong></span><span>回答記録 <strong>{summary?.attempts ?? "–"} 件</strong></span>{trial ? <span>今日の回答 <strong>{TRIAL.todayAnswers(trial.questionsUsed, trial.questionsLimit)}</strong></span> : typeof summary?.todayAttempts === "number" && <span>今日の回答 <strong>{summary.todayAttempts} 件</strong></span>}{summary && summary.todayAverage !== undefined && <span>今日の平均 <strong>{scoreText(summary.todayAverage)}</strong></span>}{summary && summary.averageScore !== undefined && <span>全体の平均 <strong>{scoreText(summary.averageScore)}</strong></span>}</div>
      {missingKeys.length > 0 && <p className="instant-warning">{keyWarning(missingKeys)}</p>}
      {summary?.providerBlock && <p className="instant-warning" role="status">{summary.providerBlock.message}（しばらくは呼び出しを止めています。）</p>}
      {!settingsReady ? <p className="note">{trial ? "1問の時間を読み込んでいます。" : "1問の時間と問題数を読み込んでいます。"}</p>
       : active ? <p className="setup-current">1問の時間：<strong>{questionSecondsLabel(questionSeconds)}</strong>（{trial ? "1問の時間" : "1問の時間と問題数"}は、出題中は変えられません）</p>
       : <details className="setup-panel"><summary><span className="setup-summary-label">練習の設定</span><span><span className="setup-summary-item">1問の時間 <strong>{questionSecondsLabel(questionSeconds)}</strong> ・</span> <span className="setup-summary-item">1回 <strong>{trial ? TRIAL_SESSION_SIZE : questionCount}問</strong> ・</span> <span className="setup-summary-item">読み上げ <strong>{SPEECH_SPEED_LABEL[speechSpeed]}</strong></span></span><span className="setup-summary-action" aria-hidden="true"></span></summary><div className="instant-setup">
          <fieldset className="setup-box"><legend>1問の時間</legend>
            <div className="time-dial">
              <button type="button" className="time-step" tabIndex={-1} aria-label="1秒短くする" aria-controls="time-value" disabled={!canShorter} onClick={() => chooseQuestionSeconds(stepQuestionSeconds(questionSeconds, -1))}>−</button>
              <div id="time-value" className="time-value" role="spinbutton" tabIndex={0} aria-label="1問の時間" aria-valuemin={QUESTION_SECONDS_MIN} aria-valuemax={QUESTION_SECONDS_MAX} aria-valuenow={questionSeconds} aria-valuetext={questionSecondsLabel(questionSeconds)} aria-describedby="time-help" onKeyDown={onTimeKeyDown}>
                <strong>{questionSeconds}</strong>秒
              </div>
              <button type="button" className="time-step" tabIndex={-1} aria-label="1秒長くする" aria-controls="time-value" disabled={!canLonger} onClick={() => chooseQuestionSeconds(stepQuestionSeconds(questionSeconds, 1))}>＋</button>
            </div>
            <div className="setup-choices" role="group" aria-label="よく使う時間">
              {QUESTION_SECONDS_PRESETS.map((s) => <button type="button" key={s} className="quiet setup-choice" aria-pressed={questionSeconds === s} onClick={() => chooseQuestionSeconds(s)}>{s}秒</button>)}
            </div>
            <p className="note" id="time-help">{timeNote}</p>
          </fieldset>
          <fieldset className="setup-box"><legend>1回の問題数</legend>
            {trial ? <p className="note">{TRIAL.settingsFixed}</p> : <div className="setup-choices setup-choices--count">
              {QUESTION_COUNT_OPTIONS.map((n) => <button type="button" key={n} className="quiet setup-choice" aria-pressed={questionCount === n} onClick={() => chooseQuestionCount(n)}>{n}問</button>)}
            </div>}
            {!trial && <p className="note">{countNote}</p>}
          </fieldset>
          <fieldset className="setup-box"><legend>読み上げの速さ</legend>
            <div className="setup-choices" role="group" aria-label="読み上げの速さ">
              {(["normal", "slow"] as const).map((s) => <button type="button" key={s} className="quiet setup-choice" aria-pressed={speechSpeed === s} onClick={() => chooseSpeechSpeed(s)}>{SPEECH_SPEED_LABEL[s]}</button>)}
            </div>
            <p className="note">答え合わせの「▶ 再生」で聞く英語の速さです。{trial && "速さを変えて同じ文を聞き直すと、読み上げの回数を1回使います。"}</p>
          </fieldset>
        </div></details>}
      <p className="note setup-status" role="status">{settingsNoteText}</p>
      {!active && !results && <button onClick={() => void startRun()} disabled={startDisabled}>スタート</button>}
      {!active && !results && trialBlocked && <span className="note trial-blocked">{trialBlocked}</span>}
      <button className="quiet" onClick={() => void loadHistory()} disabled={busy || active}>{showHistory ? "回答履歴を閉じる" : "回答履歴を見る"}</button>
      <p className="note" role="status">{run.phase === "mic" ? "マイクの許可を待っています。" : message}</p>
      {/* 使い方（説明はここにまとめる。2026-10-21 利用者の依頼）。外側の暗い所を押しても閉じる。Esc でも閉じる（dialog の標準） */}
      <dialog ref={helpDialog} className="help-dialog" aria-labelledby="help-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="help-body">
          <div className="help-head"><h2 id="help-title">瞬間英作文の使い方</h2><button type="button" className="quiet help-close" aria-label="閉じる" onClick={() => helpDialog.current?.close()}>×</button></div>
          <h3>進め方</h3>
          <ul className="instant-intro">
            <li>日本語を見て、英語で話してください。</li>
            {introLines.map((line) => <li key={line}>{line}</li>)}
            <li>意味が伝わり、合計{PASS_SCORE}点以上なら合格です（表現は模範文と違ってもかまいません）。</li>
            <li>3回連続で合格すると、その問題は出題から外れます。</li>
          </ul>
          <h3>採点について</h3>
          <ul className="instant-notes">
            <li>点数は意味80点＋文法20点の100点満点で、意味が伝わっていて合計{PASS_SCORE}点以上なら合格です。</li>
            <li>意味が伝わっていても、文法などで合計が{PASS_SCORE}点に届かなければ不合格になります。</li>
            <li>声は Gemini が英語の文字に書き起こし、その文字を Claude が採点します。文字だけで採点するので、発音の点数は付けません。</li>
            <li>録音はブラウザでWAVに変換して聞き取りに送り、保存しません。声が無い区間は、ブラウザで判定して送りません。</li>
            <li>声を検出できなかった問題（「次へ」で進んだ問題を含む）は「回答なし」として不合格になります。</li>
            <li>聞き取りや採点が失敗した問題は、記録を変えません。</li>
          </ul>
          {summary && !trial && <><h3>別の端末で使うとき</h3>
          <ul className="instant-notes">
            <li>別のブラウザや別の端末（Cloudflareに置いた場合）で開いても、合言葉を入れれば同じ記録で続けられます。</li>
            <li>複数の端末で同時に回答することはできません。やめるときは「停止」を押すか、一時停止のままにして、もう片方で続けます。</li>
          </ul></>}
          {trial && <><h3>お試しのきまり</h3>
          <ul className="instant-notes">
            <li>1日{trial.questionsLimit}問まで答えられます。</li>
            <li>読み上げは1日{trial.speechLimit}回までです。一度再生した文は、このページを開いている間は何度でも聞けます。</li>
            <li>別の端末や別のブラウザで使うときは、合言葉のあと、名前と「引き継ぎ番号」（右上のボタンで見られます）を入れると同じ記録で続けられます。2台で同時には使わないでください。</li>
            {trial.endsOn && <li>お試しは{endsOnLabel(trial.endsOn)}までです。</li>}
          </ul></>}
          <p className="help-foot"><button type="button" onClick={() => helpDialog.current?.close()}>閉じる</button></p>
        </div>
      </dialog>
    </section>

    {question && run.countdown && <section className="instant-question" data-phase={run.phase} data-question-id={question.id}>
      <p className="eyebrow">{run.position + 1} / {run.questions.length} 問目 · {question.category}</p>
      <h2>{question.japanese}</h2>
      <p className="instant-countdown">残り <strong>{remainingWholeSeconds(run.countdown, clock)}</strong> 秒</p>
      <progress max={limitSeconds * 1000} value={remainingMs(run.countdown, clock)} aria-label="残り時間" />
      {run.phase === "running"
        ? <><button onClick={skipToNext} disabled={!canSkip(run, clock)} aria-keyshortcuts="Tab">次へ<span className="key-hint">（Tab）</span></button><button onClick={() => pauseRun()}>一時停止</button><span className="record-live" role="status">録音中</span></>
        : <><button onClick={() => void resumeRun()} disabled={resuming}>再開</button><span className="instant-paused" role="status">一時停止中</span></>}
      <button className="record-stop" onClick={() => stopRunWith(STOP_TEXT)}>停止</button>
      <p className="note">英語で答えてください。答え終わったら<span className="key-hint"> Tab キーか</span>「次へ」で次の問題へ進めます（{limitSeconds}秒たつと自動で進みます）。その問題の声を採点に送ります。答え合わせは最後にまとめて表示します。{pending ? ` 採点中 ${pending}件` : ""}</p>
    </section>}

    {run.phase === "finishing" && <section className="instant-finishing" data-phase="finishing">
      <h2>採点の結果を待っています</h2>
      <p>残り {pending} 件</p>
      {showGiveUp && pending > 0 && <><button className="quiet" onClick={giveUp}>待たずに答え合わせを見る</button><p className="note">まだ返っていない問題は未採点になり、記録は変えません。</p></>}
      {finalizeFailed && <button onClick={() => void finalizeRun()}>答え合わせを読み込み直す</button>}
    </section>}

    {results && <section className="instant-results"><div className="section-title"><h2>答え合わせ</h2>{!trialBlocked && <button onClick={() => void startRun()} disabled={startDisabled || active}>次の{nextCount}問を始める</button>}{trialBlocked && <span className="note trial-blocked">{trialBlocked}</span>}</div>
      {speechUsedUp && <p className="note">{SPEECH_USED_UP_TEXT}</p>}
      <p>{counts.recorded ? `${counts.recorded}問を記録 · 合格 ${counts.passed}問 · 平均 ${counts.averageScore}点` : "記録した回答はありません"}{counts.unscored ? ` · 未採点 ${counts.unscored}問` : ""}{results.endedReason === "stopped" ? "（途中で停止）" : ""}{results.questionSeconds !== undefined ? ` · 1問の時間 ${questionSecondsLabel(results.questionSeconds)}` : ""}</p>
      {!rows.length && <p>答えた問題はありません。</p>}
      <ol>{rows.map((row) => {
        const item = row.attempt;
        const fix = item && row.status === "answered" ? correctionToShow(item, row.question.referenceAnswer) : null;
        return <li key={item?.id ?? row.question.id} className="instant-result"><h3>{row.question.japanese}</h3>
          {row.status === "answered" && item && <>
            <p className={item.passed ? "pass" : "fail"}>{item.passed ? "合格" : "不合格"} · {item.score}点（意味 {item.meaningScore} / 80、文法 {item.grammarScore} / 20） · 連続 {item.consecutivePasses} / 3</p>
            {isMeaningOkBelowPass(item) && <p className="instant-near-pass">意味は伝わっていますが、合計が{PASS_SCORE}点に届かなかったため不合格です。{fix ? "「あなたの文を直すと」と「文法・言い方」を見てください。" : "「文法・言い方」と模範文を見てください。"}</p>}
            <p>あなたの回答：<span lang="en">{item.transcript}</span></p>
            <p className="model-answer"><span className="model-answer-label">模範文</span><span lang="en">{row.question.referenceAnswer}</span> {playButton(row.question.id)}</p>
            {fix && <p>あなたの文を直すと：<span lang="en">{fix}</span> {playButton(row.question.id, item.id)}</p>}
            <p>意味の評価：{item.reasonJa}</p>
            <p>文法・言い方：{item.grammarFeedbackJa || "大きな修正はありません。"}</p>
          </>}
          {row.status === "no_answer" && item && <>
            <p className="fail">不合格 · 0点 · {item.reasonJa || "時間内に回答がありませんでした。"} 連続 {item.consecutivePasses} / 3</p>
            <p>あなたの回答：（なし）</p>
            {row.audio && <p className="note">声として数えた長さ {row.audio.voicedSec}秒（合計0.3秒以上で回答として扱います）</p>}
            <p className="model-answer"><span className="model-answer-label">模範文</span><span lang="en">{row.question.referenceAnswer}</span> {playButton(row.question.id)}</p>
          </>}
          {row.status === "unscored" && <>
            <p className="instant-unscored">採点できませんでした（記録は変えていません）</p>
            <p className="note">{row.message}</p>
            {row.transcript && <p>聞き取った回答：<span lang="en">{row.transcript}</span></p>}
            <p className="model-answer"><span className="model-answer-label">模範文</span><span lang="en">{row.question.referenceAnswer}</span> {playButton(row.question.id)}</p>
          </>}
        </li>;
      })}</ol>
    </section>}

    {showHistory && history && <section className="instant-history" ref={historySection}><h2>問題ごとの回答履歴</h2><p className="note">全100問の連続合格数と、これまでの回答を確認できます。</p><div className="instant-history-list">{history.progress.map(({ question: q, consecutivePasses, clearedAt, attempts }) => <details key={q.id}><summary>{q.id} · {q.japanese}　{clearedAt ? "クリア" : `連続 ${consecutivePasses} / 3`}　回答 {attempts.length}件</summary>{attempts.length ? <ol>{attempts.map((attempt) => { const fix = correctionToShow(attempt, attempt.referenceAnswer); return <li key={attempt.id}><time>{new Date(attempt.createdAt).toLocaleString("ja-JP")}</time> · {attempt.passed ? "合格" : "不合格"} · {attempt.score}点<br/>回答：{attempt.outcome === "no_answer" ? "（回答なし）" : <span lang="en">{attempt.transcript}</span>}<br/>模範文：<span lang="en">{attempt.referenceAnswer}</span>{attempt.outcome === "no_answer" ? null : <><br/>改善：{attempt.grammarFeedbackJa || "大きな修正はありません。"}{fix && <><br/>直すと：<span lang="en">{fix}</span></>}</>}</li>; })}</ol> : <p>まだ回答していません。</p>}</details>)}</div></section>}
  </>;
}
