// Worker の Hono（src/server/app.ts）の試験。ASSETS と practice は偽、API の処理は本物（node:sqlite の上）。
// このアプリの決まり（cookie 名 app_gate・X-App・JSON の形・COOKIE_SECRET は任意・10字以上の合言葉）を確かめる
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_BODY_LIMIT, createWorkerApp, DEFAULT_BODY_LIMIT, type WorkerEnv } from "../src/server/app";
import { issueToken, resolveCookieSecret } from "../src/server/gate/token";
import { forbidNetwork } from "./helpers/no-network";
import { fakeAssets, fakePractice, gateCookie, INDEX_HTML, rawReq } from "./helpers/fakes";
import { migratedDb } from "./helpers/sqlite";
import { speechLike, toBase64, toWav } from "./helpers/wav-fixtures";

forbidNetwork();

const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
const PW = "仮の合言葉-test-1234567"; // 18字
const SECRET = "t".repeat(40);
const H = "https://speak25.example.workers.dev";
const X = { "X-App": "1" };
const XJ = { "X-App": "1", "Content-Type": "application/json" };

function setup(over: Partial<WorkerEnv> = {}, now = NOW) {
  const db = migratedDb(now);
  const assets = fakeAssets();
  const clock = { t: now };
  const practice = fakePractice(db, () => clock.t);
  const app = createWorkerApp<WorkerEnv>({ practice: () => practice, now: () => clock.t });
  const env: WorkerEnv = { ASSETS: assets, GATE_PASSWORD: PW, COOKIE_SECRET: SECRET, ...over };
  const req = (path: string, init?: RequestInit, base = H) => app.request(base + path, init, env);
  const login = (password: string, base = H, extra: Record<string, string> = {}) =>
    req("/login", { method: "POST", headers: { ...XJ, ...extra }, body: JSON.stringify({ password }) }, base);
  const cookie = async () => `app_gate=${await issueToken(await resolveCookieSecret(env), (env.GATE_PASSWORD ?? "").trim(), clock.t)}`;
  return { db, assets, practice, app, env, req, login, cookie, clock };
}

// ---- 転送（段1） ----

test("/api/* は practice（DO）に渡り、no-store が付く。応答は書き換えられる Response で返る", async () => {
  const s = setup();
  const c = await s.cookie();
  const res = await s.req("/api/health", { headers: { Cookie: c } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, app: "speak25", schemaVersion: 3 });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(s.practice.fetched, ["GET /api/health"]);
  assert.deepEqual(s.assets.requests, []);
  const post = await s.req("/api/instant/reset", { method: "POST", headers: { ...XJ, Cookie: c }, body: "{}" });
  assert.equal(post.status, 200);
  assert.equal(post.headers.get("Cache-Control"), "no-store");
  const unknown = await s.req("/api/nothing", { headers: { Cookie: c } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("Cache-Control"), "no-store");
  assert.equal((await unknown.json()).reason, "not_found");
});

test("GET / は ASSETS へ行き、html には private, no-cache が付く。/assets/* の200は immutable、404 は違う", async () => {
  const s = setup();
  const c = await s.cookie();
  const res = await s.req("/", { headers: { Cookie: c } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), INDEX_HTML);
  assert.equal(res.headers.get("Cache-Control"), "private, no-cache");
  assert.deepEqual(s.practice.fetched, []);
  const asset = await s.req("/assets/x.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  const missing = await s.req("/assets/nothing.css");
  assert.equal(missing.status, 404);
  assert.notEqual(missing.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  // ヘッダーを変えられない Response（redirect）を ASSETS が返しても、写してから返すので例外にならない
  const redirected = await s.req("/index.html", { headers: { Cookie: c } });
  assert.equal(redirected.status, 307);
});

test("ログイン後の POST /（GET 以外）は405の JSON で、ASSETS も practice も呼ばない", async () => {
  const s = setup();
  const c = await s.cookie();
  for (const [method, path] of [["POST", "/"], ["PUT", "/anything"], ["DELETE", "/login"]] as const) {
    const res = await s.req(path, { method, headers: { ...X, Cookie: c } });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "この操作は受け付けていません。", reason: "method_not_allowed" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
  assert.deepEqual(s.assets.requests, []);
  assert.deepEqual(s.practice.fetched, []);
});

// ---- 門 ----

test("cookie 無しの GET / は 302 /login・no-store", async () => {
  const s = setup();
  const res = await s.req("/");
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("Location")?.endsWith("/login"));
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(s.assets.requests, []);
});

test("cookie 無しの GET /api/health は 401 の JSON で、practice は呼ばれない", async () => {
  const s = setup();
  const res = await s.req("/api/health");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.reason, "unauthorized");
  assert.equal(typeof body.error, "string");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(s.practice.fetched.length, 0);
});

test("GET /login は 200 で ASSETS の / を返す（ログイン画面は React 側）", async () => {
  const s = setup();
  const res = await s.req("/login");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), INDEX_HTML);
  assert.deepEqual(s.assets.requests, ["/"]);
  assert.equal(res.headers.get("Cache-Control"), "private, no-cache");
});

test("POST /login：X-App 無しは 403 で loginAttempt は呼ばれない", async () => {
  const s = setup();
  const res = await s.req("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PW }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, "forbidden");
  assert.equal(s.practice.attempts.length, 0);
});

test("X-App の確かめは GET・HEAD・OPTIONS 以外のすべてに掛かる（reset・no-answer・finish・speech・settings の PUT・logout を含む）", async () => {
  const s = setup();
  const c = await s.cookie();
  const targets: Array<[string, string]> = [
    ["POST", "/api/instant/reset"], ["POST", "/api/instant/no-answer"], ["POST", "/api/instant/finish"], ["POST", "/api/instant/speech"],
    ["POST", "/api/instant/start"], ["POST", "/api/instant/answer"], ["PUT", "/api/instant/settings"], ["DELETE", "/api/instant/settings"],
    ["PATCH", "/api/instant/settings"], ["POST", "/logout"], ["POST", "/login"],
  ];
  for (const [method, path] of targets) {
    const without = await s.req(path, { method, headers: { Cookie: c, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(without.status, 403, `${method} ${path}（X-App 無し）`);
    assert.equal((await without.json()).reason, "forbidden", `${method} ${path}`);
    const wrong = await s.req(path, { method, headers: { Cookie: c, "X-App": "0", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(wrong.status, 403, `${method} ${path}（X-App が 1 でない）`);
  }
  assert.equal(s.practice.fetched.length, 0);
  assert.equal(s.practice.attempts.length, 0);
  // GET と OPTIONS は印が要らない
  assert.equal((await s.req("/api/health", { headers: { Cookie: c } })).status, 200);
  assert.notEqual((await s.req("/api/health", { method: "OPTIONS", headers: { Cookie: c } })).status, 403);
  // 印があれば通る
  assert.equal((await s.req("/api/instant/reset", { method: "POST", headers: { ...XJ, Cookie: c }, body: "{}" })).status, 200);
});

test("POST /login：壊れた本文は 400 で数えない", async () => {
  const s = setup();
  for (const body of ["not json", "[]", "{}", JSON.stringify({ password: 1 }), JSON.stringify({ password: "" }), JSON.stringify({ password: "x".repeat(257) })]) {
    const res = await s.req("/login", { method: "POST", headers: XJ, body });
    assert.equal(res.status, 400, body.slice(0, 20));
    assert.equal((await res.json()).reason, "bad_request");
  }
  assert.equal(s.practice.attempts.length, 0);
});

test("POST /login：本文が 4096 バイトを超えると 413", async () => {
  const s = setup();
  const res = await s.req("/login", { method: "POST", headers: XJ, body: JSON.stringify({ password: "a".repeat(5000) }) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).reason, "too_large");
  assert.equal(s.practice.attempts.length, 0);
});

test("違う合言葉は 401、正しい合言葉は 200 で cookie が付く", async () => {
  const s = setup();
  const bad = await s.login("違う合言葉");
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: "合言葉が違います。", reason: "wrong" });
  assert.equal(gateCookie(bad), null);
  const ok = await s.login(PW);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const c = gateCookie(ok) ?? "";
  assert.match(c, /^app_gate=v1\.\d+\.[0-9a-f]{64}/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=15552000/);
  assert.match(c, /Path=\//);
  assert.match(c, /Secure/);
});

test("cookie の Secure：http://localhost では付かない", async () => {
  const s = setup();
  const ok = await s.login(PW, "http://localhost:8820");
  assert.equal(ok.status, 200);
  assert.doesNotMatch(gateCookie(ok) ?? "", /Secure/);
  assert.match(gateCookie(ok) ?? "", /HttpOnly/);
});

test("5 回違えた後は 429・Retry-After（正しくても）", async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.login("違う合言葉")).status, 401);
  const limited = await s.login("違う合言葉");
  assert.equal(limited.status, 429);
  const retry = Number(limited.headers.get("Retry-After"));
  assert.ok(retry >= 1 && retry <= 600);
  const body = await limited.json() as { error: string; reason: string; retryAfterSec: number };
  assert.equal(body.reason, "limited");
  assert.equal(body.retryAfterSec, retry);
  assert.match(body.error, /約\d+分後/);
  assert.equal((await s.login(PW)).status, 429);
});

test("通しの流れ：ログイン → cookie で status → ログアウト → cookie を消す", async () => {
  const s = setup();
  const ok = await s.login(PW);
  const cookie = (gateCookie(ok) ?? "").split(";")[0] as string;
  const status = await s.req("/api/instant/status", { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  assert.ok((await status.json()).generationId);
  const out = await s.req("/logout", { method: "POST", headers: X });
  assert.equal(out.status, 200);
  assert.match(gateCookie(out) ?? "", /Max-Age=0/);
});

test("GET /login：cookie つきは 302 /", async () => {
  const s = setup();
  const res = await s.req("/login", { headers: { Cookie: await s.cookie() } });
  assert.equal(res.status, 302);
  assert.ok(new URL(res.headers.get("Location") ?? "", H).pathname === "/");
});

test("期限切れ・壊れた cookie は 302／401 で、cookie を消す Set-Cookie が付く", async () => {
  const s = setup();
  const old = `app_gate=${await issueToken(SECRET, PW, NOW - 181 * 24 * 3600 * 1000)}`;
  const r1 = await s.req("/", { headers: { Cookie: old } });
  assert.equal(r1.status, 302);
  assert.match(gateCookie(r1) ?? "", /Max-Age=0/);
  const c = await s.cookie();
  const broken = c.slice(0, -1) + (c.endsWith("0") ? "1" : "0");
  const r2 = await s.req("/api/health", { headers: { Cookie: broken } });
  assert.equal(r2.status, 401);
  assert.match(gateCookie(r2) ?? "", /Max-Age=0/);
  assert.equal(s.practice.fetched.length, 0);
});

test("POST /logout は X-App が要り、Max-Age=0 の cookie を返す（cookie 無しでも 200）", async () => {
  const s = setup();
  assert.equal((await s.req("/logout", { method: "POST" })).status, 403);
  const res = await s.req("/logout", { method: "POST", headers: X });
  assert.equal(res.status, 200);
  assert.match(gateCookie(res) ?? "", /^app_gate=;?/);
  assert.match(gateCookie(res) ?? "", /Max-Age=0/);
});

test("合言葉が10字未満・空・無しのとき：POST /login 503、/api 503、更新系 503、GET / は 302 /login、GET /login は 200", async () => {
  for (const over of [{ GATE_PASSWORD: "" }, { GATE_PASSWORD: "x".repeat(9) }, { GATE_PASSWORD: " " + "x".repeat(9) + " " }, { GATE_PASSWORD: undefined }]) {
    const s = setup(over);
    const login = await s.login("x");
    assert.equal(login.status, 503);
    const body = await login.json();
    assert.equal(body.reason, "not_configured");
    assert.match(body.error, /GATE_PASSWORD/);
    assert.match(body.error, /10字/);
    assert.equal((await s.req("/api/health")).status, 503);
    assert.equal((await s.req("/api/instant/reset", { method: "POST", headers: XJ, body: "{}" })).status, 503);
    const root = await s.req("/");
    assert.equal(root.status, 302);
    assert.ok(root.headers.get("Location")?.endsWith("/login"));
    assert.equal((await s.req("/login")).status, 200);
    assert.equal((await s.req("/logout", { method: "POST", headers: X })).status, 200);
    assert.equal(s.practice.attempts.length, 0);
  }
});

test("COOKIE_SECRET が無くても（合言葉から導く）入れて、cookie で API が使える", async () => {
  for (const over of [{ COOKIE_SECRET: undefined }, { COOKIE_SECRET: "short" }]) {
    const s = setup(over);
    const ok = await s.login(PW);
    assert.equal(ok.status, 200);
    const cookie = (gateCookie(ok) ?? "").split(";")[0] as string;
    assert.equal((await s.req("/api/health", { headers: { Cookie: cookie } })).status, 200);
  }
});

test("合言葉を変えると、前の cookie は使えない（401）。COOKIE_SECRET を変えても同じ", async () => {
  const s = setup({ COOKIE_SECRET: undefined });
  const cookie = (gateCookie(await s.login(PW)) ?? "").split(";")[0] as string;
  assert.equal((await s.req("/api/health", { headers: { Cookie: cookie } })).status, 200);
  const changed = { ...s.env, GATE_PASSWORD: PW + "-変更" };
  assert.equal((await s.app.request(H + "/api/health", { headers: { Cookie: cookie } }, changed)).status, 401);
  const s2 = setup();
  const cookie2 = (gateCookie(await s2.login(PW)) ?? "").split(";")[0] as string;
  assert.equal((await s2.app.request(H + "/api/health", { headers: { Cookie: cookie2 } }, { ...s2.env, COOKIE_SECRET: "u".repeat(40) })).status, 401);
});

test("32字以上の COOKIE_SECRET があれば、その鍵で署名した cookie が通る", async () => {
  const s = setup();
  const token = await issueToken(SECRET, PW, NOW);
  assert.equal((await s.req("/api/health", { headers: { Cookie: `app_gate=${token}` } })).status, 200);
});

test("ループバック以外の http は GET が 308 https、POST は 403", async () => {
  const s = setup();
  const get = await s.req("/login", undefined, "http://example.com");
  assert.equal(get.status, 308);
  assert.equal(get.headers.get("Location"), "https://example.com/login");
  const post = await s.login(PW, "http://example.com");
  assert.equal(post.status, 403);
  assert.equal((await post.json()).reason, "https_required");
  assert.equal(s.practice.attempts.length, 0);
  assert.equal((await s.req("/api/health", undefined, "http://example.com")).status, 308);
});

// ---- 守りのヘッダー ----

test("HTML と API の応答に守りのヘッダーが付く（CSP の media-src・Permissions-Policy・X-Robots-Tag を含む）", async () => {
  const s = setup();
  const html = await s.req("/login");
  const csp = html.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /media-src 'self' blob:/);
  assert.equal(html.headers.get("X-Frame-Options"), "DENY");
  assert.equal(html.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(html.headers.get("Referrer-Policy"));
  assert.match(html.headers.get("Permissions-Policy") ?? "", /microphone=\(self\)/);
  assert.equal(html.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const api = await s.req("/api/health", { headers: { Cookie: await s.cookie() } });
  assert.equal(api.headers.get("X-Frame-Options"), "DENY");
  assert.match(api.headers.get("X-Robots-Tag") ?? "", /noindex/);
  assert.ok(api.headers.get("Content-Security-Policy"));
});

test("302・401・アセット・アイコンの応答にも X-Robots-Tag と CSP が付く", async () => {
  const s = setup();
  for (const [path, status] of [["/", 302], ["/api/health", 401], ["/assets/x.js", 200], ["/icon.svg", 200]] as const) {
    const res = await s.req(path);
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow", path);
    assert.ok(res.headers.get("Content-Security-Policy"), path);
  }
});

test("ヘッダーを変更できない ASSETS の応答（Response.redirect）でも例外にならず、守りのヘッダーが付く", async () => {
  const s = setup();
  const res = await s.req("/index.html", { headers: { Cookie: await s.cookie() } });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.ok(res.headers.get("Content-Security-Policy"));
});

test("practice.fetch が例外を投げると 500 で、本文に例外の文字が入らない", async () => {
  const s = setup();
  const app = createWorkerApp<WorkerEnv>({
    practice: () => ({ fetch: async () => { throw new Error("秘密のパス /secret"); }, loginAttempt: async () => ({ result: "ok" }), trialRegister: async () => ({ ok: false, reason: "trial_off" }), trialParticipants: async () => ({ ok: false }) }),
    now: () => NOW,
  });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await app.request(H + "/api/health", { headers: { Cookie: await s.cookie() } }, s.env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "サーバーで問題が起きました。", reason: "internal" });
    assert.ok(res.headers.get("X-Frame-Options"));
  } finally {
    console.error = original;
  }
});

// ---- 門の外のパス ----

test("門の外のパスが practice に届かない／門を通れない書き方は ASSETS にも行かない", async () => {
  const s = setup();
  for (const p of ["/assets/..%2Fapi/health", "/assets/..%2Fapi%2Fhealth", "/assets/a/b.js", "/icon-999.png", "/login/x"]) {
    const res = await s.req(p);
    assert.equal(res.status, 302, p);
  }
  assert.equal(s.practice.fetched.length, 0);
  assert.equal(s.assets.requests.length, 0);
});

test("cookie 無しの GET・HEAD のアイコンは ASSETS に届き、1 日のキャッシュが付く（practice は呼ばれない）", async () => {
  const s = setup();
  for (const path of ["/icon.svg", "/icon-32.png", "/apple-touch-icon.png"]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await s.req(path, { method });
      assert.equal(res.status, 200, `${method} ${path}`);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400", path);
    }
  }
  assert.equal(s.practice.fetched.length, 0);
});

test("cookie 無しの更新系は 401（X-App があるとき）。ログイン後の POST / は 405", async () => {
  const s = setup();
  const res = await s.req("/api/anything", { method: "POST", headers: XJ, body: "{}" });
  assert.equal(res.status, 401);
  const root = await s.req("/", { method: "POST", headers: XJ, body: "{}" });
  assert.equal(root.status, 401);
  const rootAuthed = await s.req("/", { method: "POST", headers: { ...XJ, Cookie: await s.cookie() }, body: "{}" });
  assert.equal(rootAuthed.status, 405);
});

// ---- 未認証のときは本文を読まない ----

test("cookie 無しの POST /api/instant/answer は 401 で、本文のストリームを読まない", async () => {
  const s = setup();
  let pulled = false;
  // highWaterMark: 0 にして、誰かが読みに来たときだけ pull が呼ばれるようにする（Request を作っただけでは読まれない）
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); },
  }, { highWaterMark: 0 });
  const request = new Request(H + "/api/instant/answer", { method: "POST", body, headers: XJ, duplex: "half" } as RequestInit & { duplex: "half" });
  const res = await s.app.fetch(request, s.env);
  assert.equal(res.status, 401);
  assert.equal(pulled, false);
  assert.equal(s.practice.fetched.length, 0);
});

// ---- 本文の上限 ----

test("Content-Length が上限を超える更新系は 413 で、DO を呼ばない（answer は 4,194,304、そのほかは 61,440）", async () => {
  const s = setup();
  const c = await s.cookie();
  const headers = (len: number) => ({ ...XJ, Cookie: c, "Content-Length": String(len) });
  const big = await s.req("/api/instant/answer", { method: "POST", headers: headers(ANSWER_BODY_LIMIT + 1), body: "{}" });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).reason, "too_large");
  const settings = await s.req("/api/instant/settings", { method: "PUT", headers: headers(DEFAULT_BODY_LIMIT + 1), body: "{}" });
  assert.equal(settings.status, 413);
  assert.equal(s.practice.fetched.length, 0);
  // 上限ちょうどは DO まで届く（本文は {} と食い違うので Hono/DO 側の判断。ここでは 413 でないことと DO に届くことだけ）
  const exact = await s.req("/api/instant/settings", { method: "PUT", headers: headers(DEFAULT_BODY_LIMIT), body: "{}" });
  assert.notEqual(exact.status, 413);
});

// ---- 正規化されていない URL ----

test("正規化されていない URL（..・%2e%2e）でも、cookie 無しなら practice に届かない（GET はログイン画面、POST は 400）", async () => {
  for (const u of ["http://localhost/api/%2e%2e/login", "http://localhost/api/../login", "http://localhost/api/./../login"]) {
    const s = setup();
    const res = await s.app.fetch(rawReq(u), s.env);
    assert.equal(res.status, 200, `GET ${u}`);
    assert.equal(s.practice.fetched.length, 0, `${u} が DO に届いた`);
    const post = await s.app.fetch(rawReq(u, "POST", { "X-App": "1" }), s.env);
    assert.equal(post.status, 400, `POST ${u}`);
    assert.equal(s.practice.fetched.length, 0, `POST ${u} が DO に届いた`);
  }
});

test("cookie 無しの GET /%61pi/health は門と道筋が同じ判断をする（/api の道筋に入らず 302 /login）", async () => {
  const s = setup();
  const res = await s.app.fetch(rawReq("http://localhost/%61pi/health"), s.env);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("Location")?.endsWith("/login"));
  assert.equal(s.practice.fetched.length, 0);
});

test("cookie つきの /%61pi/health は /api の道筋に入らず、ASSETS へ行って404（practice は 0）。/apix・/api.json も届かない", async () => {
  const s = setup();
  const c = await s.cookie();
  const res = await s.app.fetch(rawReq("http://localhost/%61pi/health", "GET", { Cookie: c }), s.env);
  assert.equal(res.status, 404);
  assert.equal(s.practice.fetched.length, 0);
  assert.deepEqual(s.assets.requests, ["/%61pi/health"]);
  for (const path of ["/apix", "/api.json", "/apiX/health"]) {
    assert.equal((await s.req(path, { headers: { Cookie: c } })).status, 404, path);
  }
  assert.equal(s.practice.fetched.length, 0);
});

test("cookie つきの /api/%2e%2e/api/health は DO まで届き 200（DO の Hono も同じ getPath を使う）", async () => {
  const s = setup();
  const c = await s.cookie();
  const res = await s.app.fetch(rawReq("http://localhost/api/%2e%2e/api/health", "GET", { Cookie: c }), s.env);
  assert.equal(res.status, 200);
  assert.deepEqual(s.practice.fetched, ["GET /api/health"]);
  const dotted = await s.app.fetch(rawReq("http://localhost/api/../api/health", "GET", { Cookie: c }), s.env);
  assert.equal(dotted.status, 200);
});

// ---- 通し ----

test("通し：ログイン → status → start → answer（偽の AI）→ finish", async () => {
  const s = setup();
  const cookie = (gateCookie(await s.login(PW)) ?? "").split(";")[0] as string;
  const post = (path: string, data: unknown) => s.req(path, { method: "POST", headers: { ...XJ, Cookie: cookie }, body: JSON.stringify(data) });
  const status = await (await s.req("/api/instant/status", { headers: { Cookie: cookie } })).json();
  assert.equal(status.geminiConfigured, true);
  const started = await (await post("/api/instant/start", { generationId: status.generationId })).json();
  const sessionId = started.session.id as string;
  const questionId = started.session.pendingQuestionIds[0] as string;
  const answered = await post("/api/instant/answer", { sessionId, questionId, mimeType: "audio/wav", audioBase64: toBase64(toWav(speechLike())) });
  assert.equal(answered.status, 200, await answered.clone().text());
  const body = await answered.json();
  assert.equal(body.attempt.passed, true);
  const finished = await post("/api/instant/finish", { sessionId, reason: "stopped" });
  assert.equal(finished.status, 200);
  assert.equal((await finished.json()).items.length >= 1, true);
});

test("合言葉の前後の空白・改行は、secret 側も入力側も無視する（両側の組み合わせ）", async () => {
  const core = "空白テスト-合言葉-1234567";
  for (const stored of [core, ` ${core}\n`, `${core}\r\n`]) {
    for (const typed of [core, ` ${core} `, `${core}\n`, `\t${core}`]) {
      const s = setup({ GATE_PASSWORD: stored });
      assert.equal((await s.login(typed)).status, 200, JSON.stringify([stored, typed]));
    }
    assert.equal((await setup({ GATE_PASSWORD: stored }).login(core + "x")).status, 401);
  }
});

test("257字以上の合言葉は門が閉じ（503）、256字ちょうどは入れる", async () => {
  const long = "a".repeat(257);
  const s = setup({ GATE_PASSWORD: long });
  const res = await s.login(long);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, "not_configured");
  assert.match(body.error, /256字/);
  assert.equal((await s.req("/api/health")).status, 503);
  const ok = "a".repeat(256);
  assert.equal((await setup({ GATE_PASSWORD: ok }).login(ok)).status, 200);
});
