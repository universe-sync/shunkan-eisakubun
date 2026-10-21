export const QUESTION_SECONDS: 10;
export const QUESTION_MS: number;
export const NO_LIMIT_CAP_MS: number;
export const FINISH_WAIT_HINT_MS: number;
export type Countdown = { durationMs: number | null; startedAt: number; pausedAt: number | null; pausedMs: number };
export function startCountdown(now: number, durationMs?: number | null): Countdown;
export function limitMs(countdown: Countdown): number;
export function elapsedMs(countdown: Countdown, now: number): number;
export function pauseCountdown(countdown: Countdown, now: number): Countdown;
export function resumeCountdown(countdown: Countdown, now: number): Countdown;
export function remainingMs(countdown: Countdown, now: number): number;
export function remainingWholeSeconds(countdown: Countdown, now: number): number;
export function elapsedWholeSeconds(countdown: Countdown, now: number): number;
export function isTimeUp(countdown: Countdown, now: number): boolean;
export type RunQuestion = { id: string; japanese: string; category: string };
export type AudioSummary = { durationSec: number; voicedSec: number; longestRunSec: number; peakFrameDbfs: number; noiseFloorDbfs: number; thresholdDbfs: number };
export type RecordedAttempt = { id: string; questionId: string; outcome: "answered" | "no_answer"; transcript: string; score: number; passed: boolean; consecutivePasses: number };
export type Outcome =
  | { kind: "pending" }
  | { kind: "recorded"; attempt: RecordedAttempt; audio?: AudioSummary }
  | { kind: "unscored"; message: string; transcript?: string }
  | { kind: "skipped" };
export type RunPhase = "idle" | "mic" | "running" | "paused" | "finishing" | "done";
export type RunState = { phase: RunPhase; sessionId: string | null; questions: RunQuestion[]; position: number; countdown: Countdown | null; outcomes: Record<string, Outcome>; stopReason: "completed" | "stopped" | null };
export type RunEvent =
  | { type: "request_mic" } | { type: "abort" }
  | { type: "begin"; sessionId: string; questions: RunQuestion[]; now: number; durationMs?: number | null }
  | { type: "advance"; now: number } | { type: "pause"; now: number } | { type: "resume"; now: number }
  | { type: "stop"; segmentSent: boolean }
  | { type: "outcome"; questionId: string; outcome: Exclude<Outcome, { kind: "pending" }> }
  | { type: "give_up" } | { type: "done" };
export const SKIP_GUARD_MS: number;
export function canSkip(state: RunState, now: number, guardMs?: number): boolean;
export type KeyLike = { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; isComposing?: boolean };
export type NextKeyAction = "skip" | "block" | "ignore";
export function nextKeyAction(state: RunState, event: KeyLike, now: number, guardMs?: number): NextKeyAction;
export function initialRun(): RunState;
export function runReducer(state: RunState, event: RunEvent): RunState;
export function pendingCount(state: RunState): number;
export function isSettled(state: RunState): boolean;
export function currentQuestion(state: RunState): RunQuestion | null;
export type ResultAttempt = { outcome?: string; passed: boolean; score: number };
export type ResultRow<Q extends { id: string }, A extends ResultAttempt> = { question: Q; attempt: A | null; status: "answered" | "no_answer" | "unscored"; message?: string; transcript?: string; audio?: AudioSummary };
export function mergeResults<Q extends { id: string }, A extends ResultAttempt>(items: { question: Q; attempt: A | null }[], outcomes: Record<string, Outcome>): ResultRow<Q, A>[];
export function countResults(rows: ResultRow<{ id: string }, ResultAttempt>[]): { shown: number; recorded: number; passed: number; noAnswer: number; unscored: number; averageScore: number | null };
export function isMeaningOkBelowPass(attempt: { outcome?: string; passed: boolean; meaningEquivalent?: boolean }): boolean;
export function normalizeEnglish(text: string | null | undefined): string;
export function correctionToShow(attempt: { outcome?: string; transcript?: string; correctedAnswerEn?: string }, referenceAnswer?: string): string | null;
