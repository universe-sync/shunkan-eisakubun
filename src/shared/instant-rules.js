// 瞬間英作文の決まり（合格の点・1問の時間・1回の問題数）。画面（Vite・tsc）とサーバー（Node）の両方から読む純粋なモジュール。
// DOM にも Node の API にも触れない。サーバー（DO）は ../../shared/instant-rules.js を import する（ここが唯一の正）
export const PASS_SCORE = 80; // 合計（意味80＋文法20）がこの点以上で合格

export const NO_LIMIT = "none";            // 1問の時間「制限なし」
export const QUESTION_SECONDS_MIN = 10;
export const QUESTION_SECONDS_MAX = 30;
export const QUESTION_SECONDS_DEFAULT = 10;
export const QUESTION_SECONDS_PRESETS = Object.freeze([10, 15, 20, 30]);
export const NO_LIMIT_CAP_SECONDS = 60;    // 制限なしでも1問はここで次へ進める（放置しても録音と料金が膨らまない）

export const QUESTION_COUNT_OPTIONS = Object.freeze([10, 20, 30, 50]);
export const QUESTION_COUNT_DEFAULT = 10;

// 正しい値ならそのまま返し、正しくなければ undefined（呼ぶ側が 400 や既定に振り分ける）。文字の "15"・15.5・null は通さない
export function parseQuestionSeconds(value) {
  if (value === NO_LIMIT) return NO_LIMIT;
  return Number.isInteger(value) && value >= QUESTION_SECONDS_MIN && value <= QUESTION_SECONDS_MAX ? value : undefined;
}
export function parseQuestionCount(value) { return QUESTION_COUNT_OPTIONS.includes(value) ? value : undefined; }
// 画面の残り時間の長さ（ms）。制限なしは null
export function questionDurationMs(value) { return value === NO_LIMIT ? null : value * 1000; }
// −／＋・↑↓ の1歩。秒数は10〜30に収める。制限なしは「30秒より長い」扱い：減らすと30秒、増やしても制限なしのまま
export function stepQuestionSeconds(value, delta) {
  if (value === NO_LIMIT) return delta < 0 ? QUESTION_SECONDS_MAX : NO_LIMIT;
  return Math.min(QUESTION_SECONDS_MAX, Math.max(QUESTION_SECONDS_MIN, value + delta));
}
export function questionSecondsLabel(value) { return value === NO_LIMIT ? "制限なし" : `${value}秒`; }
