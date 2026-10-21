// Worker の Hono。すべての要求がまずここ（門）を通る（assets.run_worker_first）。仕事は「守り・門・転送」だけで、API の処理は DO の中で行う。
// cloudflare:workers を import しない（テストから読むため）。
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { LoginDecision } from "./gate/limit";
import { MAX_PASSWORD_LENGTH, passwordMatches } from "./gate/password";
import { ICON_PATHS, clientKey, cookieSecure, gateExempt, gatePassword, isConfigured, isLoopbackHost } from "./gate/policy";
import { GATE_COOKIE, GATE_MAX_AGE_SEC, issueToken, resolveCookieSecret, verifyToken } from "./gate/token";
import { requestPath } from "./path";

export interface AssetsPort { fetch(req: Request): Promise<Response> }
export interface PracticePort {
  fetch(req: Request): Promise<Response>;
  loginAttempt(key: string, ok: boolean): Promise<LoginDecision>;
}
export interface WorkerEnv { ASSETS: AssetsPort; GATE_PASSWORD?: string; COOKIE_SECRET?: string }

const NO_STORE = "no-store";
// 本文の上限。answer だけ録音（base64）が入るので大きい。DO の api.ts の値と同じ
export const ANSWER_BODY_LIMIT = 4_194_304;
export const DEFAULT_BODY_LIMIT = 61_440;
const LOGIN_BODY_LIMIT = 4096;

const NOT_CONFIGURED_MESSAGE = "合言葉（GATE_PASSWORD）が未設定か16字未満か256字超のため、門を閉じています。Cloudflare の「Variables and Secrets」に16字以上・256字以内の合言葉を Secret として登録してください。";
const UNAUTHORIZED_MESSAGE = "ログインが必要です。ページを再読み込みして、合言葉を入れてください。";

function isSafeMethod(m: string): boolean { return m === "GET" || m === "HEAD"; }
function isApiPath(p: string): boolean { return p === "/api" || p.startsWith("/api/"); }

/** ASSETS・DO の応答はヘッダーを変更できないので、必ず写してから返す */
function copy(r: Response): Response { return new Response(r.body, r); }

export function createWorkerApp<E extends WorkerEnv>(o: { practice: (env: E) => PracticePort; now?: () => number }): Hono<{ Bindings: E }> {
  const app = new Hono<{ Bindings: E }>({ getPath: requestPath });
  const now = o.now ?? (() => Date.now());

  const noStore = (c: Context): void => { c.header("Cache-Control", NO_STORE); };
  type FailStatus = 400 | 401 | 403 | 405 | 413 | 429 | 500 | 503;
  const fail = (c: Context, error: string, reason: string, status: FailStatus, extra: Record<string, unknown> = {}) => {
    noStore(c);
    return c.json({ error, reason, ...extra }, status);
  };
  const toLogin = (c: Context) => { noStore(c); return c.redirect("/login", 302); };
  const tooLarge = (c: Context) => fail(c, "送られたデータが大きすぎます。", "too_large", 413);

  // 1. 守りのヘッダー（next() の後で足す。302・401・アセットを含むすべての応答に付く）
  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'", "blob:"],          // 読み上げは blob: の URL を <audio> で鳴らす
      connectSrc: ["'self'"], fontSrc: ["'self'"], manifestSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    },
    permissionsPolicy: { microphone: ["self"], camera: [], geolocation: [], payment: [], usb: [] },
    xFrameOptions: "DENY",
  }));
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  });

  // 2. https（ループバック以外の http は GET・HEAD なら https へ 308、ほかは 403）
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      if (isSafeMethod(c.req.method)) {
        url.protocol = "https:";
        noStore(c);
        return c.redirect(url.toString(), 308);
      }
      return fail(c, "https で接続してください。", "https_required", 403);
    }
    await next();
  });

  // 3. 更新系の印（GET・HEAD・OPTIONS 以外のすべて）。別のサイトから送られた書き込みを断る
  app.use("*", async (c, next) => {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("X-App") !== "1") {
      return fail(c, "この操作は画面からだけ受け付けます。", "forbidden", 403);
    }
    await next();
  });

  // 4. 門（本文は読まない。門で止まった要求の本文は誰も読まない）
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const method = c.req.method;
    const path = c.req.path;
    if (gateExempt(method, path)) { await next(); return; }
    const api = isApiPath(path);
    if (!isConfigured(c.env)) {
      return api || !isSafeMethod(method) ? fail(c, NOT_CONFIGURED_MESSAGE, "not_configured", 503) : toLogin(c);
    }
    const token = getCookie(c, GATE_COOKIE);
    if (await verifyToken(await resolveCookieSecret(c.env), gatePassword(c.env), token, now())) {
      await next();
      return;
    }
    if (token !== undefined) {
      deleteCookie(c, GATE_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: cookieSecure(url) });
    }
    return api || !isSafeMethod(method) ? fail(c, UNAUTHORIZED_MESSAGE, "unauthorized", 401) : toLogin(c);
  });

  // 5. 本文の上限（門の後）。/login は Worker が自分で読むので bodyLimit。/api は Content-Length を先に見て、DO を呼ばずに断る
  //    Content-Length が無い送り方は、DO の readLimitedText が止める
  app.use("/login", bodyLimit({ maxSize: LOGIN_BODY_LIMIT, onError: tooLarge }));
  app.use("/api/*", async (c, next) => {
    if (!isSafeMethod(c.req.method)) {
      const declared = Number(c.req.header("Content-Length"));
      const max = c.req.path === "/api/instant/answer" ? ANSWER_BODY_LIMIT : DEFAULT_BODY_LIMIT;
      if (Number.isFinite(declared) && declared > max) return tooLarge(c);
    }
    await next();
  });

  // 6. 道筋
  app.post("/login", async (c) => {
    if (!isConfigured(c.env)) return fail(c, NOT_CONFIGURED_MESSAGE, "not_configured", 503);
    let password: unknown;
    try {
      const parsed: unknown = JSON.parse(await c.req.text());
      password = typeof parsed === "object" && parsed !== null ? (parsed as { password?: unknown }).password : undefined;
    } catch {
      password = undefined;
    }
    if (typeof password === "string") password = password.trim(); // secret 側と同じく、前後の空白・改行は無視する
    if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
      return fail(c, "送られたデータの形式が正しくありません。", "bad_request", 400);   // 失敗としては数えない
    }
    const ok = await passwordMatches(password, gatePassword(c.env));
    const d = await o.practice(c.env).loginAttempt(clientKey(c.req.raw), ok);
    noStore(c);
    if (d.result === "limited") {
      c.header("Retry-After", String(d.retryAfterSec));
      const minutes = Math.max(1, Math.ceil(d.retryAfterSec / 60));
      return c.json({ error: `合言葉の間違いが続いたため、しばらく入れません。約${minutes}分後に試してください。`, reason: "limited", retryAfterSec: d.retryAfterSec }, 429);
    }
    if (d.result === "wrong") return c.json({ error: "合言葉が違います。", reason: "wrong" }, 401);
    const token = await issueToken(await resolveCookieSecret(c.env), gatePassword(c.env), now());
    setCookie(c, GATE_COOKIE, token, {
      path: "/", httpOnly: true, sameSite: "Lax", maxAge: GATE_MAX_AGE_SEC, secure: cookieSecure(new URL(c.req.url)),
    });
    return c.json({ ok: true }, 200);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, GATE_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: cookieSecure(new URL(c.req.url)) });
    noStore(c);
    return c.json({ ok: true }, 200);
  });

  app.get("/login", async (c) => {
    if (isConfigured(c.env)) {
      const token = getCookie(c, GATE_COOKIE);
      if (await verifyToken(await resolveCookieSecret(c.env), gatePassword(c.env), token, now())) {
        noStore(c);
        return c.redirect("/", 302);
      }
    }
    // ログイン画面は React 側（同じ index.html）。ASSETS の / を写して返す
    const index = new Request(new URL("/", c.req.url).toString(), { method: "GET", headers: c.req.raw.headers });
    const r = copy(await c.env.ASSETS.fetch(index));
    r.headers.set("Cache-Control", "private, no-cache");
    return r;
  });

  app.get("/assets/*", async (c) => {
    const r = copy(await c.env.ASSETS.fetch(c.req.raw));
    if (r.status === 200) r.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return r;
  });

  // アイコン（門の外。ICON_PATHS）。名前に hash が無いので 1 日だけキャッシュ
  for (const p of ICON_PATHS) {
    app.get(p, async (c) => {
      const r = copy(await c.env.ASSETS.fetch(c.req.raw));
      if (r.status === 200) r.headers.set("Cache-Control", "public, max-age=86400");
      return r;
    });
  }

  const toPractice = async (c: Context<{ Bindings: E }>): Promise<Response> => {
    const r = copy(await o.practice(c.env).fetch(c.req.raw));
    r.headers.set("Cache-Control", NO_STORE);
    return r;
  };
  app.all("/api", toPractice);
  app.all("/api/*", toPractice);

  app.get("*", async (c) => {
    const r = copy(await c.env.ASSETS.fetch(c.req.raw));
    if ((r.headers.get("Content-Type") ?? "").startsWith("text/html")) r.headers.set("Cache-Control", "private, no-cache");
    return r;
  });

  app.all("*", (c) => fail(c, "この操作は受け付けていません。", "method_not_allowed", 405));

  // 7. 例外
  app.onError((err, c) => {
    console.error(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : "不明な例外");
    return fail(c, "サーバーで問題が起きました。", "internal", 500);
  });

  return app;
}
