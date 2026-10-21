import { createInstantApi, type InstantEnv } from "../../src/server/instant/api";
import { cryptoRandomInt } from "../../src/server/random";
import { makeFakeAi, type FakeAi } from "./fake-ai";
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
    const response = await app.request(p, data === undefined ? { method } : { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
    const text = await response.text();
    let body: any = null;
    try { body = text === "" ? null : JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  };
  return {
    app, db, ai, env, clock, waits,
    getJson: (p: string) => send("GET", p),
    putJson: (p: string, data: unknown) => send("PUT", p, data),
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
