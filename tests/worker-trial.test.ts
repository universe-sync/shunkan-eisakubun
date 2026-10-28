// お試しモード（TRIAL_MODE "1"）の Worker の試験：名前の登録・cookie（app_user）・X-User-Key の付け直し。1人用で今と同じことも固定する
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApp, type WorkerEnv } from "../src/server/app";
import { USER_KEY_HEADER, issueUserToken, linkCode } from "../src/server/gate/user-token";
import { issueToken, resolveCookieSecret } from "../src/server/gate/token";
import { forbidNetwork } from "./helpers/no-network";
import { fakeAssets, fakePractice, INDEX_HTML } from "./helpers/fakes";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();

const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);
const PW = "仮の合言葉-test-1234567";
const SECRET = "t".repeat(40);
const H = "https://speak25.example.workers.dev";
const XJ = { "X-App": "1", "Content-Type": "application/json" };
const TAKEN = "その名前はすでに登録されています。あなたの名前なら、引き継ぎ番号（6桁）を入れてください。ほかの人の名前なら、別の名前にしてください。";

function setup(trial: boolean, extra: Partial<WorkerEnv> = {}) {
  const db = migratedDb(NOW);
  const assets = fakeAssets();
  const practice = fakePractice(db, () => NOW, trial ? { TRIAL_MODE: "1" } : {});
  const app = createWorkerApp<WorkerEnv>({ practice: () => practice, now: () => NOW });
  const env: WorkerEnv = { ASSETS: assets, GATE_PASSWORD: PW, COOKIE_SECRET: SECRET, ...(trial ? { TRIAL_MODE: "1" } : {}), ...extra };
  const gate = async () => `app_gate=${await issueToken(await resolveCookieSecret(env), PW, NOW)}`;
  const send = async (path: string, init: RequestInit = {}, base = H) => app.request(base + path, init, env);
  const post = async (path: string, body: unknown, cookie: string | null, extra: Record<string, string> = {}, base = H) =>
    send(path, { method: "POST", headers: { ...XJ, ...(cookie === null ? {} : { Cookie: cookie }), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) }, base);
  return { db, assets, practice, app, env, gate, send, post };
}
const userCookie = (res: Response): string | null => res.headers.getSetCookie().find((c) => c.startsWith("app_user=")) ?? null;
const cookiePair = (setCookie: string): string => setCookie.split(";")[0] as string;

test("登録：cookie 無しは 401、X-App 無しは 403", async () => {
  const s = setup(true);
  assert.equal((await s.post("/trial/name", { name: "Mika" }, null)).status, 401);
  const res = await s.send("/trial/name", { method: "POST", headers: { "Content-Type": "application/json", Cookie: await s.gate() }, body: "{}" });
  assert.equal(res.status, 403);
});

test("正しい名前は 200 で app_user を出す（HttpOnly・Secure・SameSite=Lax・Max-Age・Path）。http://localhost では Secure なし", async () => {
  const s = setup(true);
  const res = await s.post("/trial/name", { name: " Mika " }, await s.gate());
  assert.equal(res.status, 200);
  const registered = await res.json();
  assert.deepEqual(registered, { ok: true, name: "Mika", code: await linkCode(SECRET, "mika") });
  assert.match(registered.code, /^\d{6}$/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const c = userCookie(res) as string;
  assert.match(c, /^app_user=u1\./);
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=15552000", "Path=/"]) assert.ok(c.includes(part), `${part}: ${c}`);
  const local = await s.post("/trial/name", { name: "Local" }, await s.gate(), {}, "http://localhost");
  assert.equal(local.status, 200);
  assert.ok(!(userCookie(local) as string).includes("Secure"));
});

test("だめな名前は 400（cookie なし）、重複は 409（cookie なし）、4096バイト超は 413", async () => {
  const s = setup(true);
  const g = await s.gate();
  for (const body of [{ name: "   " }, { name: "あ".repeat(21) }, { name: 5 }, {}, "not json", { name: "x".repeat(201) }]) {
    const res = await s.post("/trial/name", body, g);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).reason, "bad_name");
    assert.equal(userCookie(res), null);
  }
  assert.equal((await s.post("/trial/name", { name: "Mika" }, g)).status, 200);
  const dup = await s.post("/trial/name", { name: "MIKA" }, g);
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: TAKEN, reason: "name_taken" });
  assert.equal(userCookie(dup), null);
  const big = await s.post("/trial/name", { name: "a".repeat(5000) }, g);
  assert.equal(big.status, 413);
  assert.equal(userCookie(big), null);
});

test("自分の cookie を持っていれば同じ名前をもう一度送っても 200（二度押し）", async () => {
  const s = setup(true);
  const g = await s.gate();
  const first = await s.post("/trial/name", { name: "Mika" }, g);
  const pair = cookiePair(userCookie(first) as string);
  const again = await s.post("/trial/name", { name: "mika" }, `${g}; ${pair}`);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).name, "Mika");
  assert.equal(s.db.all("SELECT * FROM users").length, 1);
});

test("登録の後、app_gate と app_user で送ると DO は登録した鍵を受け取る", async () => {
  const s = setup(true);
  const g = await s.gate();
  const pair = cookiePair(userCookie(await s.post("/trial/name", { name: "たかこ" }, g)) as string);
  const res = await s.send("/api/instant/status", { headers: { Cookie: `${g}; ${pair}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(s.practice.userKeys, ["たかこ"]);
  const raw = s.practice.requests[0] as Request;
  assert.match(raw.headers.get(USER_KEY_HEADER) as string, /^[A-Za-z0-9_-]+$/); // 日本語はそのままではなく base64url
});

test("偽装：app_user 無しの X-User-Key は捨てる／他人の名前を名乗っても自分の鍵／1人用でも捨てる", async () => {
  const s = setup(true);
  const g = await s.gate();
  const alice = btoa("alice").replace(/=+$/, "");
  await s.send("/api/health", { headers: { Cookie: g, [USER_KEY_HEADER]: alice } });
  assert.deepEqual(s.practice.userKeys, [null]);
  const bob = cookiePair(userCookie(await s.post("/trial/name", { name: "Bob" }, g)) as string);
  await s.send("/api/health", { headers: { Cookie: `${g}; ${bob}`, [USER_KEY_HEADER]: alice } });
  assert.equal(s.practice.userKeys.at(-1), "bob");
  // 署名が正しくない app_user・別の秘密で作った app_user は無いものとして扱う
  const forged = await issueUserToken("z".repeat(40), "alice", NOW);
  await s.send("/api/health", { headers: { Cookie: `${g}; app_user=${forged}` } });
  assert.equal(s.practice.userKeys.at(-1), null);

  const solo = setup(false);
  await solo.send("/api/health", { headers: { Cookie: await solo.gate(), [USER_KEY_HEADER]: alice } });
  assert.deepEqual(solo.practice.userKeys, [null]);
  assert.equal(solo.practice.requests[0]?.headers.has(USER_KEY_HEADER), false);
});

test("/trial/leave は app_user を消す（Max-Age=0）", async () => {
  const s = setup(true);
  const res = await s.post("/trial/leave", {}, await s.gate());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const c = userCookie(res) as string;
  assert.match(c, /^app_user=;/);
  assert.ok(c.includes("Max-Age=0"));
});

test("1人用では今と同じ：/trial/name・/trial/leave は未知の POST と同じ 405、大きな本文でも 405、/trial/admin は ASSETS の 404", async () => {
  const s = setup(false);
  const g = await s.gate();
  const probe = await s.post("/nothing", {}, g);
  assert.equal(probe.status, 405);
  const probeBody = await probe.json();
  for (const path of ["/trial/name", "/trial/leave"]) {
    const res = await s.post(path, { name: "Mika" }, g);
    assert.equal(res.status, 405, path);
    assert.deepEqual(await res.json(), probeBody);
    assert.equal(res.headers.get("Cache-Control"), probe.headers.get("Cache-Control"));
    assert.equal(userCookie(res), null);
  }
  const big = await s.post("/trial/name", { name: "a".repeat(10000) }, g);
  assert.equal(big.status, 405);
  assert.equal(userCookie(big), null);
  const admin = await s.send("/trial/admin", { headers: { Cookie: g } });
  assert.equal(admin.status, 404);
  assert.ok(s.assets.requests.includes("/trial/admin"));
  assert.equal(s.db.all("SELECT * FROM users").length, 0);
});

test("1人用で X-User-Key が無ければ、DO へ渡す Request は受けたものと同じオブジェクト", async () => {
  const s = setup(false);
  const req = new Request(`${H}/api/health`, { headers: { Cookie: await s.gate() } });
  const res = await s.app.fetch(req, s.env);
  assert.equal(res.status, 200);
  assert.equal(s.practice.requests[0], req);
});

test("お試しで本文のある要求（POST）を付け直しても本文が DO に届く", async () => {
  const s = setup(true);
  const g = await s.gate();
  const pair = cookiePair(userCookie(await s.post("/trial/name", { name: "Mika" }, g)) as string);
  const put = await s.send("/api/instant/settings", { method: "PUT", headers: { ...XJ, Cookie: `${g}; ${pair}` }, body: JSON.stringify({ questionSeconds: 15, questionCount: 20 }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { questionSeconds: 15, questionCount: 20 });
});

// ---- 管理用の一覧（オーナーだけ） ----
const ADMIN = "管理用の長い合言葉-".padEnd(34, "x"); // 34字
const adminCall = (s: ReturnType<typeof setup>, token: unknown, cookie: string | null, extra: Record<string, string> = {}, path = "/trial/admin/participants") =>
  s.post(path, { token }, cookie, extra);

test("管理用：未設定・31字・257字は 503 で、合言葉の試みとして数えない", async () => {
  for (const token of [undefined, "a".repeat(31), "a".repeat(257)]) {
    const s = setup(true, token === undefined ? {} : { TRIAL_ADMIN_TOKEN: token });
    const res = await adminCall(s, "whatever", await s.gate());
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.reason, "admin_not_configured");
    assert.ok(body.error.includes("未設定か、32字未満・256字超のため"), body.error);
    assert.equal(s.practice.attempts.length, 0);
  }
  const s = setup(true, { TRIAL_ADMIN_TOKEN: ADMIN });
  assert.equal((await adminCall(s, "", await s.gate())).status, 400); // 形が違う本文も数えない
  assert.equal((await adminCall(s, 5, await s.gate())).status, 400);
  assert.equal((await adminCall(s, "a".repeat(257), await s.gate())).status, 400);
  assert.equal(s.practice.attempts.length, 0);
});

test("管理用：違う合言葉は 403 で ok:false として数え、5回違うと 429。そのあとはメンバーの /login も同じ IP で 429", async () => {
  const s = setup(true, { TRIAL_ADMIN_TOKEN: ADMIN });
  const g = await s.gate();
  for (let i = 0; i < 5; i += 1) {
    const res = await adminCall(s, `wrong-${i}`, g);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "管理用の合言葉が違います。", reason: "wrong" });
  }
  assert.deepEqual(s.practice.attempts.map((x) => x.ok), [false, false, false, false, false]);
  const limited = await adminCall(s, ADMIN, g);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("Retry-After"));
  const login = await s.post("/login", { password: PW }, null);
  assert.equal(login.status, 429);
});

test("管理用：正しい合言葉は 200 no-store で一覧を返す。cookie 無しは 401、X-App 無しは 403、1人用は 405、合言葉を URL に入れても読まない", async () => {
  const s = setup(true, { TRIAL_ADMIN_TOKEN: ADMIN });
  const g = await s.gate();
  await s.post("/trial/name", { name: "Mika" }, g);
  const ok = await adminCall(s, ` ${ADMIN} `, g);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.participants.map((p: { name: string }) => p.name), ["Mika"]);
  assert.ok(body.daily && typeof body.todayJpy === "number");
  assert.equal((await adminCall(s, ADMIN, null)).status, 401);
  const noMark = await s.send("/trial/admin/participants", { method: "POST", headers: { "Content-Type": "application/json", Cookie: g }, body: JSON.stringify({ token: ADMIN }) });
  assert.equal(noMark.status, 403);
  const inUrl = await s.post(`/trial/admin/participants?token=${encodeURIComponent(ADMIN)}`, { token: "wrong" }, g);
  assert.equal(inUrl.status, 403);
  const solo = setup(false, { TRIAL_ADMIN_TOKEN: ADMIN });
  const probe = await solo.post("/nothing", {}, await solo.gate());
  const res = await adminCall(solo, ADMIN, await solo.gate());
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), await probe.json());
  assert.equal(solo.practice.attempts.length, 0);
});

test("管理用ページ：お試しのときは index.html（private, no-cache）。門の外には出ない", async () => {
  const s = setup(true, { TRIAL_ADMIN_TOKEN: ADMIN });
  const res = await s.send("/trial/admin", { headers: { Cookie: await s.gate() } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), INDEX_HTML);
  assert.equal(res.headers.get("Cache-Control"), "private, no-cache");
  const gated = await s.send("/trial/admin");
  assert.equal(gated.status, 302);
});

test("引き継ぎ番号：/trial/code は登録済みの人に同じ番号を返し、cookie なしは 403、1人用は未知の POST と同じ 405", async () => {
  const s = setup(true);
  const g = await s.gate();
  const reg = await s.post("/trial/name", { name: "Mika" }, g);
  const { code } = await reg.json();
  const pair = cookiePair(userCookie(reg) as string);
  const res = await s.post("/trial/code", {}, `${g}; ${pair}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true, code });
  const none = await s.post("/trial/code", {}, g);
  assert.equal(none.status, 403);
  assert.equal((await none.json()).reason, "trial_name_required");
  const solo = setup(false);
  const probe = await solo.post("/nothing", {}, await solo.gate());
  const soloRes = await solo.post("/trial/code", {}, await solo.gate());
  assert.equal(soloRes.status, 405);
  assert.deepEqual(await soloRes.json(), await probe.json());
});

test("引き継ぎ番号：同じ名前は番号なしなら 409、正しい番号（全角でも）なら 200 で app_user が出て、その cookie で同じ鍵が DO に届く", async () => {
  const s = setup(true);
  const g = await s.gate();
  const first = await s.post("/trial/name", { name: "Mika" }, g);
  const { code } = await first.json();
  const noCode = await s.post("/trial/name", { name: "mika" }, g);
  assert.equal(noCode.status, 409);
  assert.equal(userCookie(noCode), null);
  const emptyCode = await s.post("/trial/name", { name: "mika", code: "" }, g);
  assert.equal(emptyCode.status, 409);
  const wide = String(code).replace(/\d/g, (d: string) => String.fromCharCode(0xff10 + Number(d)));
  for (const sent of [code, wide]) {
    const res = await s.post("/trial/name", { name: "MIKA", code: sent }, g);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: "Mika", code });
    const c = userCookie(res) as string;
    assert.match(c, /^app_user=u1\./);
    const status = await s.send("/api/instant/status", { headers: { Cookie: `${g}; ${cookiePair(c)}` } });
    assert.equal(status.status, 200);
    assert.equal(s.practice.userKeys.at(-1), "mika");
  }
  assert.deepEqual(s.practice.attempts.map((a) => a.ok), [true, true]);
});

test("引き継ぎ番号：違う番号は 403 wrong_code（失敗として数える）。5回で番号は 429、同じ IP の /login は 429 にならない。正しい番号は ok:true", async () => {
  const s = setup(true);
  const g = await s.gate();
  const { code } = await (await s.post("/trial/name", { name: "Mika" }, g)).json();
  const wrong = String(code).slice(0, 5) + (String(code).endsWith("0") ? "1" : "0");
  for (let i = 0; i < 5; i += 1) {
    const res = await s.post("/trial/name", { name: "Mika", code: wrong }, g);
    assert.equal(res.status, 403, `${i}`);
    assert.deepEqual(await res.json(), { error: "名前か引き継ぎ番号が違います。", reason: "wrong_code" });
    assert.equal(userCookie(res), null);
  }
  assert.deepEqual(s.practice.attempts.map((a) => a.ok), [false, false, false, false, false]);
  assert.ok(s.practice.attempts.every((a) => a.key.startsWith("code:")));
  const limited = await s.post("/trial/name", { name: "Mika", code }, g);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).reason, "limited");
  assert.equal(userCookie(limited), null);
  const login = await s.send("/login", { method: "POST", headers: { ...XJ }, body: JSON.stringify({ password: PW }) });
  assert.equal(login.status, 200); // 番号の失敗は別の鍵なので、同じ IP の /login は止まらない
});

test("引き継ぎ番号：正しい合言葉で /login しても番号の失敗は消えず、次の番号の試みも 429 のまま。全体の上限には番号の失敗も数える", async () => {
  const s = setup(true);
  const g = await s.gate();
  const { code } = await (await s.post("/trial/name", { name: "Mika" }, g)).json();
  const wrong = String(code).slice(0, 5) + (String(code).endsWith("0") ? "1" : "0");
  for (let i = 0; i < 5; i += 1) await s.post("/trial/name", { name: "Mika", code: wrong }, g);
  const login = await s.send("/login", { method: "POST", headers: { ...XJ }, body: JSON.stringify({ password: PW }) });
  assert.equal(login.status, 200);
  assert.equal((await s.post("/trial/name", { name: "Mika", code }, g)).status, 429);
  const rows = s.db.all("SELECT client_key FROM login_failures");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => String(r.client_key).startsWith("code:")));
  // 全体の上限（30）には番号の失敗も入る：別の IP の /login が、番号の失敗の分だけ早く止まる
  for (let i = 0; i < 25; i += 1) {
    await s.send("/login", { method: "POST", headers: { ...XJ, "CF-Connecting-IP": `10.0.0.${i}` }, body: JSON.stringify({ password: "違う合言葉" }) });
  }
  const blocked = await s.send("/login", { method: "POST", headers: { ...XJ, "CF-Connecting-IP": "10.0.1.1" }, body: JSON.stringify({ password: "違う合言葉" }) });
  assert.equal(blocked.status, 429);
});

test("引き継ぎ番号：未登録の名前に番号を付けると 403 wrong_code（登録されない）。33字以上・数字以外は 400 bad_code で cookie なし", async () => {
  const s = setup(true);
  const g = await s.gate();
  const unknown = await s.post("/trial/name", { name: "Ghost", code: "123456" }, g);
  assert.equal(unknown.status, 403);
  assert.equal((await unknown.json()).reason, "wrong_code");
  assert.equal((await s.post("/trial/name", { name: "Ghost" }, g)).status, 200); // 番号を消せば登録できる
  for (const code of ["1".repeat(33), "12345", "12345a", 123456, {}]) {
    const res = await s.post("/trial/name", { name: "Mika", code }, g);
    assert.equal(res.status, 400, JSON.stringify(code));
    assert.deepEqual(await res.json(), { error: "引き継ぎ番号は6桁の数字です。", reason: "bad_code" });
    assert.equal(userCookie(res), null);
  }
});

test("引き継ぎ番号：管理一覧の各参加者に code が付き、key は出さない", async () => {
  const s = setup(true, { TRIAL_ADMIN_TOKEN: ADMIN });
  const g = await s.gate();
  const { code } = await (await s.post("/trial/name", { name: "Mika" }, g)).json();
  const body = await (await adminCall(s, ADMIN, g)).json();
  assert.equal(body.participants[0].code, code);
  assert.equal("key" in body.participants[0], false);
});

test("引き継ぎ番号：他人の名前で違う番号を4回 → 自分の名前で正しい番号を1回、を繰り返しても失敗は消えず、いずれ 429（文は番号用）", async () => {
  const s = setup(true);
  const g = await s.gate();
  const { code } = await (await s.post("/trial/name", { name: "Mika" }, g)).json();
  await s.post("/trial/name", { name: "Alice" }, g);
  const wrong = String(code).slice(0, 5) + (String(code).endsWith("0") ? "1" : "0");
  let last: Response | null = null;
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) last = await s.post("/trial/name", { name: "Alice", code: wrong }, g);
    last = await s.post("/trial/name", { name: "Mika", code }, g);
    if (last.status === 429) break;
  }
  assert.equal((last as Response).status, 429);
  const body = await (last as Response).json();
  assert.equal(body.reason, "limited");
  assert.match(body.error, /^引き継ぎ番号の間違いが続いたため、しばらく入れません。約\d+分後に試してください。$/);
  assert.equal(s.db.all("SELECT client_key FROM login_failures").length >= 5, true);
});
