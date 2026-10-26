import { createInstantApi, type InstantEnv } from "../../src/server/instant/api";
import { cryptoRandomInt } from "../../src/server/random";
import { makeFakeAi, type FakeAi } from "./fake-ai";
import { USER_KEY_HEADER, encodeUserKey } from "../../src/server/gate/user-token";
import { trialConfig } from "../../src/server/trial/config";
import { registerUser } from "../../src/server/trial/users";
import { migratedDb } from "./sqlite";

export const T0 = Date.UTC(2026, 9, 21, 3, 0, 0);

/** DO の中の API を、node:sqlite の上の本物で作る。外部 API は偽（ai）。app.request で直に呼ぶ */
export function makeApi(o: { now?: number; env?: Partial<InstantEnv>; ai?: FakeAi; randomInt?: (max: number) => number } = {}) {
  const clock = { now: o.now ?? T0 };
  const db = migratedDb(clock.now);
  const ai = o.ai ?? makeFakeAi();
  const env: InstantEnv = { GEMINI_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only", ...o.env };
  const waits: number[] = [];
  const app = createInstantApi({
    db, env, now: () => clock.now, newId: () => crypto.randomUUID(), randomInt: o.randomInt ?? cryptoRandomInt,
    fetch: ai.fetch, wait: async (ms) => { waits.push(ms); },
  });
  const send = async (method: string, p: string, data?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(p, data === undefined ? (Object.keys(headers).length ? { method, headers } : { method }) : { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
    const text = await response.text();
    let body: any = null;
    try { body = text === "" ? null : JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  };
  return {
    app, db, ai, env, clock, waits,
    getJson: (p: string, headers: Record<string, string> = {}) => send("GET", p, undefined, headers),
    putJson: (p: string, data: unknown, headers: Record<string, string> = {}) => send("PUT", p, data, headers),
    postJson: (p: string, data: unknown, headers: Record<string, string> = {}) => send("POST", p, data, headers),
  };
}
export type TestApi = ReturnType<typeof makeApi>;

/** 出題を始めて、出題 ID と問題 ID の並びを返す */
export async function beginSession(a: TestApi, questionCount = 10) {
  const status = (await a.getJson("/api/instant/status")).body;
  const started = await a.postJson("/api/instant/start", { generationId: status.generationId, questionCount });
  if (started.status !== 200) throw new Error(`start が ${started.status}: ${JSON.stringify(started.body)}`);
  return { sessionId: started.body.session.id as string, ids: started.body.session.pendingQuestionIds as string[] };
}

/** お試しモード（TRIAL_MODE "1"）の API。as(name) で名前を登録した人として呼ぶ（Worker が付ける X-User-Key を付ける） */
export function makeTrialApi(o: { now?: number; env?: Partial<InstantEnv>; ai?: FakeAi } = {}) {
  const a = makeApi({ ...(o.now !== undefined ? { now: o.now } : {}), ...(o.ai ? { ai: o.ai } : {}), env: { TRIAL_MODE: "1", ...o.env } });
  const cfg = trialConfig(a.env);
  const as = (name: string) => {
    const r = registerUser(a.db, cfg, name, null, a.clock.now);
    if (!r.ok || !r.key) throw new Error(`登録できません: ${r.reason}`);
    const headers = { [USER_KEY_HEADER]: encodeUserKey(r.key) };
    return {
      key: r.key, headers,
      getJson: (p: string) => a.getJson(p, headers),
      postJson: (p: string, data: unknown) => a.postJson(p, data, headers),
      putJson: (p: string, data: unknown) => a.putJson(p, data, headers),
    };
  };
  return { ...a, as, cfg };
}
export type TrialApiUser = ReturnType<ReturnType<typeof makeTrialApi>["as"]>;
