// Worker の Hono。すべての要求がまずここ（門）を通る（assets.run_worker_first）。仕事は「守り・門・転送」だけで、API の処理は DO の中で行う。
// cloudflare:workers を import しない（テストから読むため）。
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { LoginDecision } from "./gate/limit";
import { NAME_REQUIRED_MESSAGE, NAME_RULE_MESSAGE, nameKey, normalizeDisplayName, normalizeLinkCode } from "../shared/trial-rules.js";
import { MAX_PASSWORD_LENGTH, passwordMatches } from "./gate/password";
import { ICON_PATHS, clientKey, cookieSecure, gateExempt, gatePassword, isConfigured, isLoopbackHost } from "./gate/policy";
import { USER_COOKIE, USER_KEY_HEADER, USER_MAX_AGE_SEC, encodeUserKey, issueUserToken, linkCode, linkCodeMatches, verifyUserToken } from "./gate/user-token";
import { GATE_COOKIE, GATE_MAX_AGE_SEC, issueToken, resolveCookieSecret, verifyToken } from "./gate/token";
import { requestPath } from "./path";
import { trialEnabled } from "./trial/config";
import type { TrialParticipantsResult } from "./trial/admin";
import type { TrialRegisterResult } from "./trial/users";

export interface AssetsPort { fetch(req: Request): Promise<Response> }
export interface PracticePort {
  fetch(req: Request): Promise<Response>;
  loginAttempt(key: string, ok: boolean, clearOnOk?: boolean): Promise<LoginDecision>;
  trialRegister(name: string, currentKey: string | null, resume: boolean): Promise<TrialRegisterResult>;
  trialParticipants(): Promise<TrialParticipantsResult>;
}
export interface WorkerEnv { ASSETS: AssetsPort; GATE_PASSWORD?: string; COOKIE_SECRET?: string; TRIAL_MODE?: string; TRIAL_ADMIN_TOKEN?: string }

const NO_STORE = "no-store";
// 本文の上限。answer だけ録音（base64）が入るので大きい。DO の api.ts の値と同じ
export const ANSWER_BODY_LIMIT = 4_194_304;
export const DEFAULT_BODY_LIMIT = 61_440;
const LOGIN_BODY_LIMIT = 4096;
const TRIAL_BODY_LIMIT = 4096;
const ADMIN_TOKEN_MIN = 32; // 管理用の合言葉（TRIAL_ADMIN_TOKEN）の長さ
const CODE_INPUT_MAX = 32; // 引き継ぎ番号の入力の長さの上限（これを超えたら形が違う）
const NAME_INPUT_MAX = 200; // これを超える文字は名前として読まない（長すぎる入力を DO へ送らない）

const NOT_CONFIGURED_MESSAGE = "合言葉（GATE_PASSWORD）が未設定か10字未満か256字超のため、門を閉じています。Cloudflare の「Variables and Secrets」に10字以上・256字以内の合言葉を Secret として登録してください。";
const UNAUTHORIZED_MESSAGE = "ログインが必要です。ページを再読み込みして、合言葉を入れてください。";

function isSafeMethod(m: string): boolean { return m === "GET" || m === "HEAD"; }
function isApiPath(p: string): boolean { return p === "/api" || p.startsWith("/api/"); }

/** ASSETS・DO の応答はヘッダーを変更できないので、必ず写してから返す */
function copy(r: Response): Response { return new Response(r.body, r); }

export function createWorkerApp<E extends WorkerEnv>(o: { practice: (env: E) => PracticePort; now?: () => number }): Hono<{ Bindings: E }> {
  const app = new Hono<{ Bindings: E }>({ getPath: requestPath });
  const now = o.now ?? (() => Date.now());

  const noStore = (c: Context): void => { c.header("Cache-Control", NO_STORE); };
  type FailStatus = 400 | 401 | 403 | 405 | 409 | 413 | 429 | 500 | 503;
  const fail = (c: Context, error: string, reason: string, status: FailStatus, extra: Record<string, unknown> = {}) => {
    noStore(c);
    return c.json({ error, reason, ...extra }, status);
  };
  // 合言葉の失敗が続いたときの 429（/login・管理用の一覧・引き継ぎ番号で同じ文）
  const limitedResponse = (c: Context, retryAfterSec: number, what = "合言葉") => {
    noStore(c);
    c.header("Retry-After", String(retryAfterSec));
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    return c.json({ error: `${what}の間違いが続いたため、しばらく入れません。約${minutes}分後に試してください。`, reason: "limited", retryAfterSec }, 429);
  };
  const toLogin = (c: Context) => { noStore(c); return c.redirect("/login", 302); };
  const trialBodyLimit = bodyLimit({ maxSize: TRIAL_BODY_LIMIT, onError: (c) => tooLarge(c) });
  const tooLarge = (c: Context) => fail(c, "送られたデータが大きすぎます。", "too_large", 413);
  const notAllowed = (c: Context) => fail(c, "この操作は受け付けていません。", "method_not_allowed", 405);
  // 最後の受け皿：ASSETS の応答を写して返す（html には private, no-cache）
  const assetsPassthrough = async (c: Context<{ Bindings: E }>): Promise<Response> => {
    const r = copy(await c.env.ASSETS.fetch(c.req.raw));
    if ((r.headers.get("Content-Type") ?? "").startsWith("text/html")) r.headers.set("Cache-Control", "private, no-cache");
    return r;
  };
  const userCookieOptions = (c: Context) => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: cookieSecure(new URL(c.req.url)) });

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
  // お試しモードのときだけ掛ける（1人用では掛けない＝大きな本文でも今と同じ 405）
  app.use("/trial/*", async (c, next) => (trialEnabled(c.env) ? trialBodyLimit(c, next) : next()));
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
    if (d.result === "limited") return limitedResponse(c, d.retryAfterSec);
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

  // お試しモードの名前。cookie（app_user）は Worker だけが出す。1人用では今と同じ 405
  // 本文は { name, code? }。code（引き継ぎ番号）が合えば、ほかの端末で登録した同じ名前に入れる
  app.post("/trial/name", async (c) => {
    if (!trialEnabled(c.env)) return notAllowed(c);
    let name: unknown;
    let codeInput: unknown;
    try {
      const parsed: unknown = JSON.parse(await c.req.text());
      const obj = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown; code?: unknown }) : {};
      name = obj.name;
      codeInput = obj.code;
    } catch {
      name = undefined;
    }
    if (typeof name !== "string" || name.length > NAME_INPUT_MAX) return fail(c, NAME_RULE_MESSAGE, "bad_name", 400);
    let code: string | null = null;
    if (codeInput !== undefined && codeInput !== "") {
      code = typeof codeInput === "string" && codeInput.length <= CODE_INPUT_MAX ? normalizeLinkCode(codeInput) : null;
      if (code === null) return fail(c, "引き継ぎ番号は6桁の数字です。", "bad_code", 400);
    }
    const secret = await resolveCookieSecret(c.env);
    const practice = o.practice(c.env);
    if (code !== null) {
      const display = normalizeDisplayName(name);
      if (display === null) return fail(c, NAME_RULE_MESSAGE, "bad_name", 400);
      const matched = await linkCodeMatches(secret, nameKey(display), code);
      // 合言葉の /login の成功で番号の失敗が消えないよう、別の鍵で数える（全体の上限だけ共有）
      const d = await practice.loginAttempt(`code:${clientKey(c.req.raw)}`, matched, false);
      if (d.result === "limited") return limitedResponse(c, d.retryAfterSec, "引き継ぎ番号");
      if (!matched) return fail(c, "名前か引き継ぎ番号が違います。", "wrong_code", 403);
    }
    const currentKey = await verifyUserToken(secret, getCookie(c, USER_COOKIE), now());
    const r = await practice.trialRegister(name, currentKey, code !== null);
    if (!r.ok || r.key === undefined) {
      if (r.reason === "bad_name") return fail(c, r.message ?? NAME_RULE_MESSAGE, "bad_name", 400);
      // 番号が付いていて名前が未登録のとき（番号を消して送り直せば登録できる）
      if (r.reason === "name_taken") return fail(c, r.message ?? "", "name_taken", 409);
      if (r.reason === "trial_closed") return fail(c, r.message ?? "", "trial_closed", 403);
      return notAllowed(c);
    }
    setCookie(c, USER_COOKIE, await issueUserToken(secret, r.key, now()), { ...userCookieOptions(c), maxAge: USER_MAX_AGE_SEC });
    noStore(c);
    return c.json({ ok: true, name: r.displayName, code: await linkCode(secret, r.key) }, 200);
  });

  // 引き継ぎ番号を見る（登録済みの人だけ。cookie の名前の鍵から計算するので DB には触らない）
  app.post("/trial/code", async (c) => {
    if (!trialEnabled(c.env)) return notAllowed(c);
    const secret = await resolveCookieSecret(c.env);
    const key = await verifyUserToken(secret, getCookie(c, USER_COOKIE), now());
    if (key === null) return fail(c, NAME_REQUIRED_MESSAGE, "trial_name_required", 403);
    noStore(c);
    return c.json({ ok: true, code: await linkCode(secret, key) }, 200);
  });

  app.post("/trial/leave", (c) => {
    if (!trialEnabled(c.env)) return notAllowed(c);
    deleteCookie(c, USER_COOKIE, userCookieOptions(c));
    noStore(c);
    return c.json({ ok: true }, 200);
  });

  // 管理用の参加者の一覧（オーナーだけ）。1人用では今と同じ 405。合言葉は本文だけで受け、失敗はメンバーの合言葉の失敗と同じ枠で数える
  app.post("/trial/admin/participants", async (c) => {
    if (!trialEnabled(c.env)) return notAllowed(c);
    const expected = (c.env.TRIAL_ADMIN_TOKEN ?? "").trim();
    if (expected.length < ADMIN_TOKEN_MIN || expected.length > MAX_PASSWORD_LENGTH) {
      return fail(c, "管理用の合言葉（TRIAL_ADMIN_TOKEN）が未設定か、32字未満・256字超のため、一覧は出せません。Cloudflare の「Variables and Secrets」に32字以上256字以内の合言葉を Secret として登録してください。", "admin_not_configured", 503);
    }
    let token: unknown;
    try {
      const parsed: unknown = JSON.parse(await c.req.text());
      token = typeof parsed === "object" && parsed !== null ? (parsed as { token?: unknown }).token : undefined;
    } catch {
      token = undefined;
    }
    if (typeof token === "string") token = token.trim();
    if (typeof token !== "string" || token.length < 1 || token.length > MAX_PASSWORD_LENGTH) return fail(c, "送られたデータの形式が正しくありません。", "bad_request", 400);
    const ok = await passwordMatches(token, expected);
    const practice = o.practice(c.env);
    const decision = await practice.loginAttempt(clientKey(c.req.raw), ok);
    if (decision.result === "limited") return limitedResponse(c, decision.retryAfterSec);
    if (decision.result === "wrong") return fail(c, "管理用の合言葉が違います。", "wrong", 403);
    const report = await practice.trialParticipants();
    if (!report.ok) return notAllowed(c);
    const secret = await resolveCookieSecret(c.env);
    const participants = await Promise.all((report.participants ?? []).map(async ({ key, ...rest }) => ({ ...rest, code: await linkCode(secret, key) })));
    noStore(c);
    return c.json({ ...report, participants }, 200);
  });

  // 管理用ページ（React 側の同じ index.html）。お試しでなければ今と同じ（最後の受け皿＝ASSETS の 404）
  app.get("/trial/admin", async (c) => {
    if (!trialEnabled(c.env)) return assetsPassthrough(c);
    const index = new Request(new URL("/", c.req.url).toString(), { method: "GET", headers: c.req.raw.headers });
    const r = copy(await c.env.ASSETS.fetch(index));
    r.headers.set("Cache-Control", "private, no-cache");
    return r;
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

  // クライアントが送った X-User-Key は必ず捨てる。お試しでは app_user を検証して Worker が付け直す（日本語をヘッダーに入れられないので base64url）
  const forwardRequest = async (c: Context<{ Bindings: E }>): Promise<Request> => {
    const raw = c.req.raw;
    const trial = trialEnabled(c.env);
    if (!trial && !raw.headers.has(USER_KEY_HEADER)) return raw; // 1人用のふだんの道：今と同じ Request をそのまま渡す
    const headers = new Headers(raw.headers);
    headers.delete(USER_KEY_HEADER);
    if (trial) {
      const key = await verifyUserToken(await resolveCookieSecret(c.env), getCookie(c, USER_COOKIE), now());
      if (key) headers.set(USER_KEY_HEADER, encodeUserKey(key));
    }
    return new Request(raw.url, { method: raw.method, headers, body: raw.body, ...(raw.body ? { duplex: "half" } : {}) } as RequestInit);
  };
  const toPractice = async (c: Context<{ Bindings: E }>): Promise<Response> => {
    const r = copy(await o.practice(c.env).fetch(await forwardRequest(c)));
    r.headers.set("Cache-Control", NO_STORE);
    return r;
  };
  app.all("/api", toPractice);
  app.all("/api/*", toPractice);

  app.get("*", assetsPassthrough);

  app.all("*", notAllowed);

  // 7. 例外
  app.onError((err, c) => {
    console.error(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : "不明な例外");
    return fail(c, "サーバーで問題が起きました。", "internal", 500);
  });

  return app;
}
