// 瞬間英作文の自動進行の、画面の段階の遷移・残り時間・答え合わせの組み立て。
// 画面（Vite・tsc）と Node の試験（server/test/instant-run.test.js）の両方から読むので、DOM には触れない純粋な関数だけ。
import { QUESTION_SECONDS_DEFAULT } from "../../shared/instant-rules.js";

export const QUESTION_SECONDS = QUESTION_SECONDS_DEFAULT;
export const QUESTION_MS = QUESTION_SECONDS * 1000;
export const FINISH_WAIT_HINT_MS = 20_000;

// 残り時間は経過時刻で計算する（setInterval の回数は数えない）。now は performance.now() の ms
// 経過は一時停止の時間を除く
export function startCountdown(now, durationMs = QUESTION_MS) { return { durationMs, startedAt: now, pausedAt: null, pausedMs: 0 }; }
export function limitMs(c) { return c.durationMs; }
export function elapsedMs(c, now) { const at = c.pausedAt ?? now; return Math.max(0, at - c.startedAt - c.pausedMs); }
export function pauseCountdown(c, now) { return c.pausedAt === null ? { ...c, pausedAt: now } : c; }
export function resumeCountdown(c, now) { return c.pausedAt === null ? c : { ...c, pausedAt: null, pausedMs: c.pausedMs + Math.max(0, now - c.pausedAt) }; }
export function remainingMs(c, now) { return Math.max(0, limitMs(c) - elapsedMs(c, now)); }
export function remainingWholeSeconds(c, now) { return Math.ceil(remainingMs(c, now) / 1000); }
export function elapsedWholeSeconds(c, now) { return Math.floor(elapsedMs(c, now) / 1000); }
export function isTimeUp(c, now) { return remainingMs(c, now) === 0; }

export const SKIP_GUARD_MS = 500;
// 問題が出てからの経過（一時停止の時間は除く）が guardMs 以上なら、Tab・「次へ」で進めてよい
export function canSkip(state, now, guardMs = SKIP_GUARD_MS) {
  if (state.phase !== "running" || !state.countdown) return false;
  return elapsedMs(state.countdown, now) >= guardMs;
}
// keydown の扱い："skip"＝既定の動作を止めて次へ、"block"＝既定の動作だけ止める、"ignore"＝何もしない（ふつうのフォーカス移動）
export function nextKeyAction(state, event, now, guardMs = SKIP_GUARD_MS) {
  if (event.key !== "Tab" || state.phase !== "running") return "ignore";           // 一時停止中・答え合わせ等はふつうの Tab
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return "ignore"; // Shift+Tab でフォーカスを戻せるようにする
  if (event.repeat || event.isComposing) return "block";                              // 押しっぱなし・変換中は進めない
  return canSkip(state, now, guardMs) ? "skip" : "block";                             // 出てすぐの Tab は進めない（2問飛ばさない）
}

export function initialRun() { return { phase: "idle", sessionId: null, questions: [], position: 0, countdown: null, outcomes: {}, stopReason: null }; }

export function runReducer(state, event) {
  switch (event.type) {
    case "request_mic": return state.phase === "idle" || state.phase === "done" ? { ...initialRun(), phase: "mic" } : state;
    case "abort": return initialRun();
    case "begin":
      if (state.phase !== "mic" || !event.questions.length) return state;
      return { ...initialRun(), phase: "running", sessionId: event.sessionId, questions: event.questions, countdown: startCountdown(event.now, event.durationMs) };
    case "advance": { // 0秒・Tab・「次へ」：今の問題を「送信待ち」にし、次へ進む
      if (state.phase !== "running") return state;
      const current = state.questions[state.position];
      const outcomes = { ...state.outcomes, [current.id]: { kind: "pending" } };
      if (state.position + 1 < state.questions.length) return { ...state, outcomes, position: state.position + 1, countdown: startCountdown(event.now, state.countdown.durationMs) };
      return { ...state, outcomes, phase: "finishing", countdown: null, stopReason: "completed" };
    }
    case "pause": return state.phase === "running" ? { ...state, phase: "paused", countdown: pauseCountdown(state.countdown, event.now) } : state;
    case "resume": return state.phase === "paused" ? { ...state, phase: "running", countdown: resumeCountdown(state.countdown, event.now) } : state;
    case "stop": { // segmentSent: 今の区間を送る（結果待ちにする）か
      if (state.phase !== "running" && state.phase !== "paused") return state;
      const current = state.questions[state.position];
      const outcomes = event.segmentSent && current ? { ...state.outcomes, [current.id]: { kind: "pending" } } : state.outcomes;
      return { ...state, outcomes, phase: "finishing", countdown: null, stopReason: "stopped" };
    }
    case "outcome": { // 結果待ちの問題だけを更新する（2回目以降・知らない問題は捨てる）
      if (state.outcomes[event.questionId]?.kind !== "pending") return state;
      return { ...state, outcomes: { ...state.outcomes, [event.questionId]: event.outcome } };
    }
    case "give_up": {
      if (state.phase !== "finishing") return state;
      const outcomes = Object.fromEntries(Object.entries(state.outcomes).map(([id, o]) => [id, o.kind === "pending" ? { kind: "unscored", message: "採点の結果を待たずに終了しました。" } : o]));
      return { ...state, outcomes };
    }
    case "done": return state.phase === "finishing" ? { ...state, phase: "done" } : state;
    default: return state;
  }
}
export function pendingCount(state) { return Object.values(state.outcomes).filter((o) => o.kind === "pending").length; }
export function isSettled(state) { return state.phase === "finishing" && pendingCount(state) === 0; }
export function currentQuestion(state) { return state.phase === "running" || state.phase === "paused" ? state.questions[state.position] ?? null : null; }

// 答え合わせの行：サーバーの記録を優先し、記録が無ければ画面が知っている「未採点」だけを足す
export function mergeResults(items, outcomes) {
  const rows = [];
  for (const item of items) {
    const local = outcomes[item.question.id];
    if (item.attempt) rows.push({ question: item.question, attempt: item.attempt, status: item.attempt.outcome === "no_answer" ? "no_answer" : "answered", audio: local?.kind === "recorded" ? local.audio : undefined });
    else if (local?.kind === "unscored") rows.push({ question: item.question, attempt: null, status: "unscored", message: local.message, transcript: local.transcript });
    // 出題しなかった問題・停止して声が無かった問題（skipped）・画面が知らない問題は出さない
  }
  return rows;
}
export function countResults(rows) {
  const recorded = rows.filter((row) => row.attempt);
  return { shown: rows.length, recorded: recorded.length, passed: recorded.filter((row) => row.attempt.passed).length, noAnswer: rows.filter((row) => row.status === "no_answer").length, unscored: rows.filter((row) => row.status === "unscored").length, averageScore: recorded.length ? Math.round(recorded.reduce((total, row) => total + row.attempt.score, 0) / recorded.length) : null };
}

// 意味は伝わった（meaningEquivalent: true）が、合計が合格の点に届かず不合格の答え（instant-v3 以降の記録だけが該当）
export function isMeaningOkBelowPass(attempt) { return attempt.outcome !== "no_answer" && attempt.meaningEquivalent === true && attempt.passed === false; }

// 英文の比べ方：大文字小文字・句読点・空白の違いは同じとみなす（’ ‘ ` は ' にそろえる）
export function normalizeEnglish(text) { return String(text ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim(); }
// 「あなたの文を直すと」に出す文。項目が無い（古い記録）・回答なし・空・あなたの回答と同じ（直す所なし）・模範文と同じなら null（出さない）
export function correctionToShow(attempt, referenceAnswer) {
  if (attempt.outcome === "no_answer" || typeof attempt.correctedAnswerEn !== "string") return null;
  const corrected = attempt.correctedAnswerEn.trim();
  const key = normalizeEnglish(corrected);
  if (!key || key === normalizeEnglish(attempt.transcript) || key === normalizeEnglish(referenceAnswer)) return null;
  return corrected;
}
