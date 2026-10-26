// 瞬間英作文の決まり（合格の点・1問の時間・1回の問題数）。画面（Vite・tsc）とサーバー（Node）の両方から読む純粋なモジュール。
// DOM にも Node の API にも触れない。サーバー（DO）は ../../shared/instant-rules.js を import する（ここが唯一の正）
export const PASS_SCORE = 80; // 合計（意味80＋文法20）がこの点以上で合格

export const QUESTION_SECONDS_MIN = 10;
export const QUESTION_SECONDS_MAX = 30;
export const QUESTION_SECONDS_DEFAULT = 10;
export const QUESTION_SECONDS_PRESETS = Object.freeze([10, 15, 20, 30]);
export const ANSWER_MAX_SECONDS = 60;      // 1区間の録音の最長（サーバーが受け付ける録音の長さの基準。1問の時間は最長30秒なので余裕がある）

export const QUESTION_COUNT_OPTIONS = Object.freeze([10, 20, 30, 50]);
export const QUESTION_COUNT_DEFAULT = 10;

// 正しい値ならそのまま返し、正しくなければ undefined（呼ぶ側が 400 や既定に振り分ける）。文字の "15"・15.5・null は通さない
export function parseQuestionSeconds(value) {
  return Number.isInteger(value) && value >= QUESTION_SECONDS_MIN && value <= QUESTION_SECONDS_MAX ? value : undefined;
}
export function parseQuestionCount(value) { return QUESTION_COUNT_OPTIONS.includes(value) ? value : undefined; }
// 画面の残り時間の長さ（ms）
export function questionDurationMs(value) { return value * 1000; }
// −／＋・↑↓ の1歩。秒数は10〜30に収める
export function stepQuestionSeconds(value, delta) {
  return Math.min(QUESTION_SECONDS_MAX, Math.max(QUESTION_SECONDS_MIN, value + delta));
}
// 前の版が記録した "none"（制限なし）は、過去の回の表示のためだけに「制限なし」と出す
export function questionSecondsLabel(value) { return value === "none" ? "制限なし" : `${value}秒`; }
