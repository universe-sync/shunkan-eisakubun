import { fileURLToPath } from "node:url";
import type { AssetsPort, PracticePort } from "../../src/server/app";
import { loginAttempt } from "../../src/server/store/login-failures";
import { createInstantApi } from "../../src/server/instant/api";
import type { Db } from "../../src/server/store/db";
import { decodeUserKey, USER_KEY_HEADER } from "../../src/server/gate/user-token";
import { trialConfig } from "../../src/server/trial/config";
import { trialParticipantsReport } from "../../src/server/trial/admin";
import { registerUser } from "../../src/server/trial/users";
import { makeFakeAi } from "./fake-ai";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const INDEX_HTML = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-AbC123.js"></script></body></html>';

/** 偽の ASSETS。/index.html は Response.redirect（ヘッダーを変更できない Response）を返す。受けた要求を記録する */
export function fakeAssets(): AssetsPort & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === "/") return new Response(INDEX_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (/^\/assets\/[^/]+\.js$/.test(path)) return new Response("console.log(1)", { status: 200, headers: { "Content-Type": "text/javascript" } });
      if (path === "/icon.svg") return new Response("<svg/>", { status: 200, headers: { "Content-Type": "image/svg+xml" } });
      if (path === "/icon-32.png" || path === "/apple-touch-icon.png") return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "Content-Type": "image/png" } });
      if (path === "/index.html") return Response.redirect("http://localhost/", 307);
      return new Response("not found", { status: 404 });
    },
  };
}

/** 偽の practice。fetch は本物の createInstantApi（偽の AI・node:sqlite）に渡す。受けた要求を記録する */
export function fakePractice(db: Db, now: () => number, env: Record<string, string> = {}): PracticePort & { fetched: string[]; attempts: Array<{ key: string; ok: boolean }>; requests: Request[]; userKeys: Array<string | null> } {
  const api = createInstantApi({ db, env: { GEMINI_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only", ...env }, now, newId: () => crypto.randomUUID(), randomInt: (max) => Math.floor(Math.random() * max), fetch: makeFakeAi().fetch });
  const fetched: string[] = [];
  const attempts: Array<{ key: string; ok: boolean }> = [];
  const requests: Request[] = [];
  const userKeys: Array<string | null> = [];
  return {
    fetched,
    attempts,
    requests,
    userKeys,
    async trialRegister(name: string, currentKey: string | null, resume: boolean) {
      return registerUser(db, trialConfig(env), name, currentKey, now(), resume);
    },
    async trialParticipants() {
      return trialParticipantsReport(db, env, now());
    },
    async fetch(req: Request): Promise<Response> {
      requests.push(req);
      userKeys.push(decodeUserKey(req.headers.get(USER_KEY_HEADER)));
      fetched.push(`${req.method} ${new URL(req.url).pathname}`);
      return api.fetch(req);
    },
    async loginAttempt(key: string, ok: boolean, clearOnOk = true) {
      attempts.push({ key, ok });
      return loginAttempt(db, key, ok, now(), undefined, clearOnOk);
    },
  };
}

/** 正規化されていない request.url（app.request は new Request() で正規化してしまうので使えない） */
export function rawReq(url: string, method = "GET", headers: Record<string, string> = {}): Request {
  const base = new Request("http://localhost/", { method, headers });
  return new Proxy(base, {
    get(t, p) {
      if (p === "url") return url;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Request;
}

/** Set-Cookie から app_gate の行を取り出す（無ければ null） */
export function gateCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith("app_gate=")) ?? null;
}
