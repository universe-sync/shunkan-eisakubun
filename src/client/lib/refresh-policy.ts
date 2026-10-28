import type { RunQuestion, RunState } from "./instant-run.js";
import { trialBlockedMessage, type TrialInfo } from "./trial-view.js";

// 画面に戻ったときの読み直しの判断（純粋な関数。DOM に触れない）

/** 最後に読み直した時刻（lastAt）から minMs 以上たったか。まだ一度も読んでいなければ（lastAt が null）真 */
export function shouldRefresh(lastAt: number | null, now: number, minMs: number): boolean {
  return lastAt === null || now - lastAt >= minMs;
}

/** 待機中の案内の文。途中の出題がある／お試し／1人用の順に決め、止まっているとき（終了日の後・今日の分を使い切った）はその理由で置き換える */
export function idleMessage(summary: { activeSession: { pendingQuestionIds: readonly string[] } | null }, trial: TrialInfo | null): string {
  const blocked = trial ? trialBlockedMessage(trial) : null;
  if (blocked) return blocked;
  const pending = summary.activeSession?.pendingQuestionIds.length ?? 0;
  if (pending) return `前回の出題が途中です。スタートすると、まだ答えていない${pending}問から続けます。`;
  return trial
    ? "スタートすると録音が始まります。1問の時間は、上の欄で選べます（お試しは1回10問です）。"
    : "スタートすると録音が始まります。1問の時間と問題数は、上の欄で選べます。";
}

/** 別の端末で出題が進んだか。サーバーの出題が無い・id が違う・今の問題がもう未回答の中に無い、のどれか */
export function sessionProgressed(
  run: Pick<RunState, "phase" | "sessionId" | "questions" | "position">,
  activeSession: { id: string; pendingQuestionIds: readonly string[] } | null,
): boolean {
  if (run.phase !== "running" && run.phase !== "paused") return false;
  if (activeSession === null || activeSession.id !== run.sessionId) return true;
  const current: RunQuestion | undefined = run.questions[run.position];
  return current === undefined || !activeSession.pendingQuestionIds.includes(current.id);
}

/** 読み直しを始めた時点と応答が届いた時点の通し番号（文・出題・リセット・設定の保存） */
export type RefreshMarks = { message: number; run: number; reset: number; save: number };

/** 応答を反映してよいか。出題かリセットが挟まっていたら何も触らない（summary）。文は、その間に誰かが変えていたら置き直さない（message）。設定は、保存が始まっていた・保存中なら適用しない（settings） */
export function refreshApplies(start: RefreshMarks, now: RefreshMarks, o: { saving: boolean }): { summary: boolean; message: boolean; settings: boolean } {
  const summary = start.run === now.run && start.reset === now.reset;
  return { summary, message: summary && start.message === now.message, settings: summary && start.save === now.save && !o.saving };
}
