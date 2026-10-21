import { QUESTION_COUNT_DEFAULT, QUESTION_SECONDS_DEFAULT, parseQuestionCount, parseQuestionSeconds, type QuestionSeconds } from "../../shared/instant-rules.js";
import type { Db } from "../store/db";
import { HttpError } from "../http";
import { isoMillis } from "../time";

// 瞬間英作文の設定（1問の時間・1回の問題数）。記録（instant_*）とは別の表で、「記録をリセット」では消さない
export interface InstantSettingsValue { questionSeconds: QuestionSeconds; questionCount: number }
export const defaultSettings = (): InstantSettingsValue => ({ questionSeconds: QUESTION_SECONDS_DEFAULT, questionCount: QUESTION_COUNT_DEFAULT });
export const SETTINGS_ERROR = "1問の時間は10〜30秒（1秒刻み）か「制限なし」、問題数は10・20・30・50問のどれかで指定してください。";

/** 表に入れる文字（10〜30 の数字の文字か none） */
export const secondsToText = (value: QuestionSeconds): string => String(value);
/** 表の文字 → 値。正しくなければ undefined */
export function secondsFromText(text: unknown): QuestionSeconds | undefined {
  if (text === "none") return "none";
  if (typeof text === "string" && /^\d+$/.test(text)) return parseQuestionSeconds(Number(text));
  return undefined;
}

export function createInstantSettings(db: Db, now: () => number) {
  return {
    // 行が無ければ既定（行は作らない）。不正な値ならその項目だけ既定にして警告だけ（ただの好みなので練習を止めない。次の保存で書き直す）
    get(): InstantSettingsValue {
      const row = db.all("SELECT question_seconds, question_count FROM instant_settings WHERE id = 1")[0];
      if (!row) return defaultSettings();
      const questionSeconds = secondsFromText(row.question_seconds);
      const questionCount = parseQuestionCount(row.question_count);
      if (questionSeconds === undefined || questionCount === undefined) console.warn("瞬間英作文の設定に正しくない値があったため、その項目は既定を使います。");
      return { questionSeconds: questionSeconds ?? QUESTION_SECONDS_DEFAULT, questionCount: questionCount ?? QUESTION_COUNT_DEFAULT };
    },
    // 2つとも必須（画面はいつも両方を送る）。正しくなければ HttpError(400)、行は変えない
    set(input: unknown): InstantSettingsValue {
      const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const questionSeconds = parseQuestionSeconds(body.questionSeconds);
      const questionCount = parseQuestionCount(body.questionCount);
      if (questionSeconds === undefined || questionCount === undefined) throw new HttpError(400, SETTINGS_ERROR);
      db.run(
        "INSERT INTO instant_settings (id, question_seconds, question_count, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET question_seconds = excluded.question_seconds, question_count = excluded.question_count, updated_at = excluded.updated_at",
        secondsToText(questionSeconds), questionCount, isoMillis(now()),
      );
      return { questionSeconds, questionCount };
    },
  };
}
