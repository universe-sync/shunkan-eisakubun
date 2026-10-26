import { QUESTION_COUNT_DEFAULT, parseQuestionCount, parseQuestionSeconds, type QuestionSeconds } from "../../shared/instant-rules.js";
import { RUBRIC_VERSION } from "../ai/claude";
import { HttpError } from "../http";
import type { Db, SqlRow, SqlValue } from "../store/db";
import { isoMillis, jstDate, jstDayRange } from "../time";
import { addTrialAnswer } from "../trial/users";
import { instantQuestionById, instantQuestions, type InstantQuestion } from "./questions";
import { secondsFromText, secondsToText } from "./settings";

// 瞬間英作文の記録（DO の SQLite の表）。関数はすべて同期で、check と write の間に await を挟まない（DO は同期のコードの途中に割り込まない）。
// 数えるのは数え用の列（instant_meta.attempt_count など）で行い、回答の全部を読まない。

export interface Evaluation {
  recognitionStatus: string;
  outcome?: string;
  transcript: string;
  meaningScore: number;
  grammarScore: number;
  score: number;
  passed: boolean;
  meaningEquivalent?: boolean;
  reasonJa: string;
  grammarFeedbackJa: string;
  correctedAnswerEn?: string;
  naturalAnswerEn?: string;
  model: string | null;
  rubricVersion: string | null;
  transcriptionModel?: string;
}
export type AttemptJson = Evaluation & { id: string; sessionId: string; questionId: string; createdAt: string; consecutivePasses: number };
export type SessionJson = { id: string; generationId: string; questionIds: string[]; index: number; startedAt: string; finishedAt: string | null; endedReason: string | null; questionSeconds?: QuestionSeconds };
export type InstantStateJson = { schemaVersion: 1; generationId: string; sessions: SessionJson[]; attempts: AttemptJson[]; progress: Record<string, { consecutivePasses: number; clearedAt: string | null }> };

export type PublicQuestion = { id: string; japanese: string; category: string };
export type PublicSession = { id: string; total: number; answeredCount: number; questions: PublicQuestion[]; pendingQuestionIds: string[] };
export type Summary = { generationId: string; total: number; cleared: number; remaining: number; attempts: number; todayAttempts: number; todayAverage: number | null; averageScore: number | null; activeSession: PublicSession | null };

// 答える時間が終わるまでに声が無かった問題の記録（外部 API は呼ばない）。連続合格は0に戻る。segmentEnd が "next" なら Tab・「次へ」で進んだ問題
export const noAnswerEvaluation = (segmentEnd: string = "timeout"): Evaluation => ({
  recognitionStatus: "no_speech", outcome: "no_answer", transcript: "", meaningScore: 0, grammarScore: 0, score: 0, passed: false,
  reasonJa: segmentEnd === "next" ? "回答がないまま次の問題へ進みました。" : "時間内に回答がありませんでした。",
  grammarFeedbackJa: "", correctedAnswerEn: "", model: null, rubricVersion: RUBRIC_VERSION,
});

const publicQuestion = (id: string): PublicQuestion => {
  const { japanese, category } = instantQuestionById.get(id) as InstantQuestion;
  return { id, japanese, category };
};
const str = (value: SqlValue | undefined): string => String(value);
/** 平均点（小数第1位で四捨五入）。1件も無ければ null。回答なしは0点で数える */
const averageScore = (sum: number, count: number): number | null => (count > 0 ? Math.round((sum / count) * 10) / 10 : null);
const questionIdsOf = (row: SqlRow): string[] => JSON.parse(str(row.question_ids)) as string[];

/** 表の1行 → 元の JSON の回答の形。値が NULL の項目は出さない（空の文字は空の文字のまま） */
function attemptFromRow(row: SqlRow): AttemptJson {
  const a: Record<string, unknown> = { id: str(row.id), sessionId: str(row.session_id), questionId: str(row.question_id), createdAt: str(row.created_at) };
  if (row.outcome !== null) a.outcome = str(row.outcome);
  a.recognitionStatus = str(row.recognition_status);
  a.transcript = str(row.transcript);
  a.meaningScore = Number(row.meaning_score);
  a.grammarScore = Number(row.grammar_score);
  a.score = Number(row.score);
  a.passed = Number(row.passed) === 1;
  if (row.meaning_equivalent !== null) a.meaningEquivalent = Number(row.meaning_equivalent) === 1;
  a.reasonJa = str(row.reason_ja);
  a.grammarFeedbackJa = str(row.grammar_feedback_ja);
  if (row.corrected_answer_en !== null) a.correctedAnswerEn = str(row.corrected_answer_en);
  if (row.natural_answer_en !== null) a.naturalAnswerEn = str(row.natural_answer_en);
  a.model = row.model === null ? null : str(row.model);
  a.rubricVersion = row.rubric_version === null ? null : str(row.rubric_version);
  if (row.transcription_model !== null) a.transcriptionModel = str(row.transcription_model);
  a.consecutivePasses = Number(row.consecutive_passes);
  return a as unknown as AttemptJson;
}

function sessionFromRow(row: SqlRow): SessionJson {
  const s: SessionJson = { id: str(row.id), generationId: str(row.generation_id), questionIds: questionIdsOf(row), index: Number(row.answered_count), startedAt: str(row.started_at), finishedAt: row.finished_at === null ? null : str(row.finished_at), endedReason: row.ended_reason === null ? null : str(row.ended_reason) };
  if (row.question_seconds !== null) {
    const seconds = secondsFromText(row.question_seconds);
    if (seconds !== undefined) s.questionSeconds = seconds;
  }
  return s;
}

/** 表から元の JSON（instant-state.json）の形を作る。テストの確かめに使う */
export function exportState(db: Db, userKey = ""): InstantStateJson {
  const meta = db.all("SELECT generation_id FROM instant_meta WHERE user_key = ?", userKey)[0];
  const progress: InstantStateJson["progress"] = {};
  for (const row of db.all("SELECT question_id, consecutive_passes, cleared_at FROM instant_progress WHERE user_key = ? ORDER BY question_id", userKey)) {
    progress[str(row.question_id)] = { consecutivePasses: Number(row.consecutive_passes), clearedAt: row.cleared_at === null ? null : str(row.cleared_at) };
  }
  return {
    schemaVersion: 1,
    generationId: meta ? str(meta.generation_id) : "",
    sessions: db.all("SELECT * FROM instant_sessions WHERE user_key = ? ORDER BY seq", userKey).map(sessionFromRow),
    attempts: db.all("SELECT * FROM instant_attempts WHERE user_key = ? ORDER BY seq", userKey).map(attemptFromRow),
    progress,
  };
}

const bool = (value: boolean | undefined): number | null => (value === undefined ? null : value ? 1 : 0);
const opt = (value: string | undefined): string | null => (value === undefined ? null : value);

const INSERT_ATTEMPT = `INSERT INTO instant_attempts (id, session_id, question_id, created_at, outcome, recognition_status, transcript, meaning_score, grammar_score, score, passed, meaning_equivalent, reason_ja, grammar_feedback_ja, corrected_answer_en, natural_answer_en, model, rubric_version, transcription_model, consecutive_passes, user_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
function insertAttempt(db: Db, a: AttemptJson, userKey: string): void {
  db.run(INSERT_ATTEMPT, a.id, a.sessionId, a.questionId, a.createdAt, opt(a.outcome), a.recognitionStatus, a.transcript, a.meaningScore, a.grammarScore, a.score, a.passed ? 1 : 0, bool(a.meaningEquivalent), a.reasonJa, a.grammarFeedbackJa, opt(a.correctedAnswerEn), opt(a.naturalAnswerEn), a.model ?? null, a.rubricVersion ?? null, opt(a.transcriptionModel), a.consecutivePasses, userKey);
}
const sessionSeconds = (value: QuestionSeconds | undefined): string | null => (value === undefined ? null : secondsToText(value));
function insertSession(db: Db, s: SessionJson, userKey: string): void {
  db.run("INSERT INTO instant_sessions (id, generation_id, question_ids, answered_count, question_seconds, started_at, finished_at, ended_reason, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", s.id, s.generationId, JSON.stringify(s.questionIds), s.index ?? 0, sessionSeconds(s.questionSeconds), s.startedAt, s.finishedAt ?? null, s.endedReason ?? null, userKey);
}

/** 元の JSON の形（Mac 版の記録を含む）を確かめて、表を空にして入れ直す。テストの下ごしらえと、記録の取り込みに使う（API の道筋は作らない） */
export function importState(db: Db, state: unknown, now: number, userKey = ""): void {
  const s = state as Partial<InstantStateJson> | null;
  if (!s || typeof s !== "object" || s.schemaVersion !== 1 || !Array.isArray(s.sessions) || !Array.isArray(s.attempts) || !s.progress || !s.generationId) throw new Error("瞬間英作文の保存データの形式が不正です。");
  db.transaction(() => {
    db.run("DELETE FROM instant_attempts WHERE user_key = ?", userKey);
    db.run("DELETE FROM instant_sessions WHERE user_key = ?", userKey);
    db.run("DELETE FROM instant_progress WHERE user_key = ?", userKey);
    db.run("DELETE FROM instant_meta WHERE user_key = ?", userKey);
    db.run("INSERT INTO instant_meta (user_key, generation_id, attempt_count, created_at, score_total) VALUES (?, ?, ?, ?, ?)", userKey, s.generationId as string, (s.attempts as unknown[]).length, isoMillis(now), (s.attempts as AttemptJson[]).reduce((sum, a) => sum + (Number.isFinite(Number(a.score)) ? Number(a.score) : 0), 0));
    for (const session of s.sessions as SessionJson[]) insertSession(db, session, userKey);
    for (const attempt of s.attempts as AttemptJson[]) insertAttempt(db, attempt, userKey);
    for (const [questionId, p] of Object.entries(s.progress as InstantStateJson["progress"])) {
      db.run("INSERT INTO instant_progress (user_key, question_id, consecutive_passes, cleared_at) VALUES (?, ?, ?, ?)", userKey, questionId, p.consecutivePasses, p.clearedAt ?? null);
    }
  });
}

export interface InstantStoreDeps { db: Db; now(): number; newId(): string; randomInt(maxExclusive: number): number; userKey: string }

export function createInstantStore(d: InstantStoreDeps) {
  const { db, userKey } = d; // userKey はこの store を作るときに束ねる（1人用は空の文字）。instant_ の表を読み書きする SQL には必ず入れる
  // 行が無ければ、最初に読んだ所で作る。こうすると status を何度読んでも同じ generationId になり、そのまま start できる
  const ensureMeta = (): { generationId: string; attemptCount: number; scoreTotal: number } => {
    let row = db.all("SELECT generation_id, attempt_count, score_total FROM instant_meta WHERE user_key = ?", userKey)[0];
    if (!row) {
      db.run("INSERT INTO instant_meta (user_key, generation_id, attempt_count, created_at) VALUES (?, ?, 0, ?)", userKey, d.newId(), isoMillis(d.now()));
      row = db.all("SELECT generation_id, attempt_count, score_total FROM instant_meta WHERE user_key = ?", userKey)[0] as SqlRow;
    }
    return { generationId: str(row.generation_id), attemptCount: Number(row.attempt_count), scoreTotal: Number(row.score_total) };
  };
  const progressMap = (): Map<string, number> => new Map(db.all("SELECT question_id, consecutive_passes FROM instant_progress WHERE user_key = ?", userKey).map((r) => [str(r.question_id), Number(r.consecutive_passes)]));
  const answeredIds = (sessionId: string): Set<string> => new Set(db.all("SELECT question_id FROM instant_attempts WHERE session_id = ? AND +user_key = ?", sessionId, userKey).map((r) => str(r.question_id)));
  const activeRow = (): SqlRow | undefined => db.all("SELECT * FROM instant_sessions WHERE user_key = ? AND finished_at IS NULL ORDER BY seq LIMIT 1", userKey)[0];
  const publicSession = (row: SqlRow | undefined): PublicSession | null => {
    if (!row) return null;
    const ids = questionIdsOf(row);
    const answered = answeredIds(str(row.id));
    return { id: str(row.id), total: ids.length, answeredCount: answered.size, questions: ids.map(publicQuestion), pendingQuestionIds: ids.filter((id) => !answered.has(id)) };
  };
  // 日本時間の今日に記録された回答の数（回答なしも数える）。記録のリセットで消える。索引 instant_attempts_user_created で範囲だけを読む
  // 今日の平均もここで一緒に出す（索引は score まで覆うので、表の行は読まない）
  const today = (): { count: number; sum: number } => {
    const { start, end } = jstDayRange(d.now());
    const row = db.all("SELECT COUNT(*) AS n, COALESCE(SUM(score), 0) AS total FROM instant_attempts WHERE user_key = ? AND created_at >= ? AND created_at < ?", userKey, start, end)[0];
    return { count: Number(row?.n), sum: Number(row?.total) };
  };
  const summary = (meta = ensureMeta()): Summary => {
    const todayStats = today();
    const progress = progressMap();
    const cleared = instantQuestions.filter((q) => (progress.get(q.id) ?? 0) >= 3).length;
    return { generationId: meta.generationId, total: instantQuestions.length, cleared, remaining: instantQuestions.length - cleared, attempts: meta.attemptCount, todayAttempts: todayStats.count, todayAverage: averageScore(todayStats.sum, todayStats.count), averageScore: averageScore(meta.scoreTotal, meta.attemptCount), activeSession: publicSession(activeRow()) };
  };
  const shuffle = <T,>(values: T[]): T[] => {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i -= 1) { const j = d.randomInt(i + 1); [copy[i], copy[j]] = [copy[j] as T, copy[i] as T]; }
    return copy;
  };
  const sessionById = (id: string): SqlRow | undefined => db.all("SELECT * FROM instant_sessions WHERE id = ? AND user_key = ?", id, userKey)[0];
  // 答え合わせ：出題順に並べ、答えが記録されていない問題は attempt が null。昨日までの記録（endedReason なし）は completed とみなす
  const buildResults = (row: SqlRow) => {
    const attempts = new Map(db.all("SELECT * FROM instant_attempts WHERE session_id = ? AND +user_key = ?", str(row.id), userKey).map((r) => [str(r.question_id), attemptFromRow(r)]));
    const session = sessionFromRow(row);
    return {
      sessionId: session.id,
      finishedAt: session.finishedAt,
      endedReason: session.endedReason || "completed",
      items: session.questionIds.map((id) => ({ question: instantQuestionById.get(id) as InstantQuestion, attempt: attempts.get(id) ?? null })),
      ...(session.questionSeconds !== undefined ? { questionSeconds: session.questionSeconds } : {}),
      summary: summary(),
    };
  };

  return {
    status: (): Summary => summary(),
    start(expectedGenerationId?: string, options: { questionSeconds?: QuestionSeconds | undefined; questionCount?: unknown; maxCount?: number } = {}) {
      const meta = ensureMeta();
      if (expectedGenerationId && expectedGenerationId !== meta.generationId) throw new HttpError(409, "記録がリセットされました。画面を更新してください。");
      // maxCount はプログラムが渡す上限。0・負・小数・NaN は誤りとして止める（slice(0, -1) で 99 問出るのを防ぐ）
      if (options.maxCount !== undefined && (!Number.isInteger(options.maxCount) || options.maxCount < 1)) throw new Error("maxCount は 1 以上の整数で指定してください。");
      const count = Math.min(parseQuestionCount(options.questionCount) ?? QUESTION_COUNT_DEFAULT, options.maxCount ?? Infinity);
      const questionSeconds = parseQuestionSeconds(options.questionSeconds); // 不正・無しは undefined（記録しない）
      const active = activeRow();
      if (active) {
        // 続きから：問題はもう決まっているので作り直さない（新しい問題数は使わない）。1問の時間は今回の値に書き換える
        if (questionSeconds !== undefined && active.question_seconds !== secondsToText(questionSeconds)) {
          db.run("UPDATE instant_sessions SET question_seconds = ? WHERE seq = ? AND user_key = ?", secondsToText(questionSeconds), active.seq as number, userKey);
        }
        return { ...summary(meta), session: publicSession(sessionById(str(active.id))), resumed: true };
      }
      const progress = progressMap();
      const pool = instantQuestions.filter((q) => (progress.get(q.id) ?? 0) < 3).map((q) => q.id);
      if (!pool.length) return { ...summary(meta), session: null as PublicSession | null, resumed: false };
      // 未クリアが選んだ数より少なければ、残りを全部出す（slice が自然にそうなる）
      const id = d.newId();
      db.run("INSERT INTO instant_sessions (id, generation_id, question_ids, answered_count, question_seconds, started_at, finished_at, ended_reason, user_key) VALUES (?, ?, ?, 0, ?, ?, NULL, NULL, ?)", id, meta.generationId, JSON.stringify(shuffle(pool).slice(0, count)), sessionSeconds(questionSeconds), isoMillis(d.now()), userKey);
      return { ...summary(meta), session: publicSession(sessionById(id)), resumed: false };
    },
    // 出題中のセッションの中で、まだ答えが記録されていない問題か（順番は問わない）
    checkAnswerable(sessionId: string, questionId: string): { generationId: string } | null {
      const meta = ensureMeta();
      const session = db.all("SELECT * FROM instant_sessions WHERE id = ? AND user_key = ? AND finished_at IS NULL", sessionId, userKey)[0];
      if (!session || str(session.generation_id) !== meta.generationId || !questionIdsOf(session).includes(questionId)) return null;
      if (db.all("SELECT 1 FROM instant_attempts WHERE session_id = ? AND question_id = ? AND user_key = ?", sessionId, questionId, userKey).length) return null; // 記録済み
      return { generationId: meta.generationId };
    },
    record(sessionId: string, questionId: string, expected: { generationId: string }, evaluation: Evaluation) {
      return db.transaction(() => {
        const meta = ensureMeta();
        const session = db.all("SELECT * FROM instant_sessions WHERE id = ? AND user_key = ? AND finished_at IS NULL", sessionId, userKey)[0];
        if (!session || str(session.generation_id) !== meta.generationId || meta.generationId !== expected.generationId || !questionIdsOf(session).includes(questionId)) return null;
        if (db.all("SELECT 1 FROM instant_attempts WHERE session_id = ? AND question_id = ? AND user_key = ?", sessionId, questionId, userKey).length) return null;
        const prior = progressMap().get(questionId) ?? 0;
        const streak = evaluation.passed ? Math.min(3, prior + 1) : 0;
        const nowMs = d.now();
        const at = isoMillis(nowMs);
        db.run("INSERT INTO instant_progress (user_key, question_id, consecutive_passes, cleared_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_key, question_id) DO UPDATE SET consecutive_passes = excluded.consecutive_passes, cleared_at = excluded.cleared_at", userKey, questionId, streak, streak === 3 ? at : null);
        const attempt: AttemptJson = { id: d.newId(), sessionId, questionId, createdAt: at, ...evaluation, consecutivePasses: streak };
        insertAttempt(db, attempt, userKey);
        db.run("UPDATE instant_meta SET attempt_count = attempt_count + 1, score_total = score_total + ? WHERE user_key = ?", attempt.score, userKey);
        if (userKey !== "") addTrialAnswer(db, userKey, jstDate(nowMs)); // お試しの今日の数（リセットで戻らない）。記録された回答と1対1
        const answered = Number(db.all("SELECT COUNT(*) AS n FROM instant_attempts WHERE session_id = ? AND +user_key = ?", sessionId, userKey)[0]?.n); // 互換のために答えた数として残す
        const total = questionIdsOf(session).length;
        if (answered >= total) db.run("UPDATE instant_sessions SET answered_count = ?, finished_at = ?, ended_reason = 'completed' WHERE id = ? AND user_key = ?", answered, at, sessionId, userKey);
        else db.run("UPDATE instant_sessions SET answered_count = ? WHERE id = ? AND user_key = ?", answered, sessionId, userKey);
        const after = sessionById(sessionId) as SqlRow;
        return {
          attempt: { id: attempt.id, questionId, outcome: attempt.outcome || "answered", transcript: attempt.transcript, score: attempt.score, passed: attempt.passed, consecutivePasses: streak },
          session: publicSession(after),
          completed: after.finished_at !== null,
          summary: summary(),
        };
      });
    },
    // 出題を終える（停止・全問そろった後）。終わっていれば何度呼んでも同じ結果（finished_at は変えない）
    finish(sessionId: string, reason: string) {
      return db.transaction(() => {
        const meta = ensureMeta();
        let row = sessionById(sessionId);
        if (!row || str(row.generation_id) !== meta.generationId) return null; // 不明・リセット後
        if (row.finished_at === null) {
          const answered = answeredIds(sessionId).size;
          db.run("UPDATE instant_sessions SET finished_at = ?, ended_reason = ? WHERE id = ? AND user_key = ?", isoMillis(d.now()), answered >= questionIdsOf(row).length ? "completed" : reason, sessionId, userKey);
          row = sessionById(sessionId) as SqlRow;
        }
        return buildResults(row);
      });
    },
    results(sessionId: string) {
      const row = db.all("SELECT * FROM instant_sessions WHERE id = ? AND user_key = ? AND finished_at IS NOT NULL", sessionId, userKey)[0];
      return row ? buildResults(row) : null;
    },
    // 回答の全部を読むのは、ボタンを押したときだけのここだけ
    history() {
      const progress = new Map(db.all("SELECT question_id, consecutive_passes, cleared_at FROM instant_progress WHERE user_key = ?", userKey).map((r) => [str(r.question_id), r]));
      const byQuestion = new Map<string, AttemptJson[]>();
      for (const row of db.all("SELECT a.* FROM instant_attempts a JOIN instant_sessions s ON s.id = a.session_id WHERE a.user_key = ? AND s.user_key = ? AND s.finished_at IS NOT NULL ORDER BY a.seq", userKey, userKey)) {
        const attempt = attemptFromRow(row);
        const list = byQuestion.get(attempt.questionId) ?? [];
        list.push(attempt);
        byQuestion.set(attempt.questionId, list);
      }
      return {
        progress: instantQuestions.map((question) => {
          const p = progress.get(question.id);
          return { question: publicQuestion(question.id), consecutivePasses: p ? Number(p.consecutive_passes) : 0, clearedAt: p && p.cleared_at !== null ? str(p.cleared_at) : null, attempts: (byQuestion.get(question.id) ?? []).map((attempt) => ({ ...attempt, referenceAnswer: question.referenceAnswer })) };
        }),
        summary: summary(),
      };
    },
    speechText(questionId: string, attemptId: string | undefined, prompt: boolean): string | null {
      const question = instantQuestionById.get(questionId);
      if (!question) return null;
      if (prompt) return question.japanese;
      if (!attemptId) {
        // 未採点の問題も、終わった出題なら模範文を読める
        const found = db.all("SELECT 1 FROM instant_sessions WHERE user_key = ? AND finished_at IS NOT NULL AND instr(question_ids, ?) > 0 LIMIT 1", userKey, `"${questionId}"`);
        return found.length ? question.referenceAnswer : null;
      }
      const row = db.all("SELECT a.corrected_answer_en, a.natural_answer_en FROM instant_attempts a WHERE a.id = ? AND a.question_id = ? AND a.user_key = ? AND EXISTS (SELECT 1 FROM instant_sessions s WHERE s.id = a.session_id AND s.user_key = ? AND s.finished_at IS NOT NULL)", attemptId, questionId, userKey, userKey)[0];
      if (!row) return null;
      return (row.corrected_answer_en !== null && str(row.corrected_answer_en)) || (row.natural_answer_en !== null && str(row.natural_answer_en)) || null;
    },
    reset(): Summary {
      return db.transaction(() => {
        db.run("DELETE FROM instant_attempts WHERE user_key = ?", userKey);
        db.run("DELETE FROM instant_sessions WHERE user_key = ?", userKey);
        db.run("DELETE FROM instant_progress WHERE user_key = ?", userKey);
        ensureMeta();
        db.run("UPDATE instant_meta SET generation_id = ?, attempt_count = 0, score_total = 0, created_at = ? WHERE user_key = ?", d.newId(), isoMillis(d.now()), userKey);
        return summary();
      });
    },
  };
}
export type InstantStore = ReturnType<typeof createInstantStore>;
