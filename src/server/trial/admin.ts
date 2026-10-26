import { guardConfig, type GuardEnv } from "../guard/config";
import { dailyState, type DailyState } from "../guard/daily-limits";
import type { Db } from "../store/db";
import { jstDate } from "../time";
import { createUsageStore } from "../usage/store";
import { trialConfig, type TrialEnv } from "./config";
import { listParticipants, type TrialParticipant } from "./users";

export interface TrialParticipantsResult { ok: boolean; date?: string; todayJpy?: number; daily?: DailyState; participants?: TrialParticipant[] }

/** 管理用の一覧（オーナーだけ）。無効なら { ok: false }。全員の今日の利用料の目安と全体の上限の状態も付ける */
export function trialParticipantsReport(db: Db, env: TrialEnv & GuardEnv, now: number): TrialParticipantsResult {
  if (!trialConfig(env).enabled) return { ok: false };
  const todayJpy = createUsageStore(db, () => now).todayJpy();
  return { ok: true, date: jstDate(now), todayJpy, daily: dailyState(db, guardConfig(env), now, todayJpy), participants: listParticipants(db, now) };
}
