import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_COOKIE, GATE_TTL_MS, issueToken, resetSecretWarning, resolveCookieSecret, verifyToken } from "../src/server/gate/token";
import { forbidNetwork } from "./helpers/no-network";

forbidNetwork();

const SECRET = "s".repeat(40);
const PW = "仮の合言葉-abc-1234567";
const NOW = 1_800_000_000_000;

test("cookie の名前は app_gate", () => {
  assert.equal(GATE_COOKIE, "app_gate");
});

test("発行して検証すると真", async () => {
  const t = await issueToken(SECRET, PW, NOW);
  assert.match(t, /^v1\.\d+\.[0-9a-f]{64}$/);
  assert.equal(await verifyToken(SECRET, PW, t, NOW), true);
});

test("MAC・発行時刻・v1 を変えると偽", async () => {
  const t = await issueToken(SECRET, PW, NOW);
  const [v, at, mac] = t.split(".") as [string, string, string];
  const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal(await verifyToken(SECRET, PW, `${v}.${at}.${flipped}`, NOW), false);
  assert.equal(await verifyToken(SECRET, PW, `${v}.${Number(at) + 1}.${mac}`, NOW), false);
  assert.equal(await verifyToken(SECRET, PW, `v2.${at}.${mac}`, NOW), false);
});

test("180 日ちょうどは真、1ms 過ぎると偽", async () => {
  const t = await issueToken(SECRET, PW, NOW);
  assert.equal(await verifyToken(SECRET, PW, t, NOW + GATE_TTL_MS), true);
  assert.equal(await verifyToken(SECRET, PW, t, NOW + GATE_TTL_MS + 1), false);
});

test("未来：59 秒先は真、61 秒先は偽", async () => {
  const future = await issueToken(SECRET, PW, NOW + 59_000);
  assert.equal(await verifyToken(SECRET, PW, future, NOW), true);
  const farther = await issueToken(SECRET, PW, NOW + 61_000);
  assert.equal(await verifyToken(SECRET, PW, farther, NOW), false);
});

test("COOKIE_SECRET・GATE_PASSWORD が違うと偽", async () => {
  const t = await issueToken(SECRET, PW, NOW);
  assert.equal(await verifyToken("x".repeat(40), PW, t, NOW), false);
  assert.equal(await verifyToken(SECRET, PW + "x", t, NOW), false);
});

test("空・null・形が違うものは偽", async () => {
  const t = await issueToken(SECRET, PW, NOW);
  const [v, at, mac] = t.split(".") as [string, string, string];
  for (const bad of [
    "", null, undefined, "v1.1", `${v}.${at}`, `${v}.abc.${mac}`, `${v}.${at}.${mac.toUpperCase()}`,
    `${v}.${at}.${mac.slice(0, 63)}`, `${v}.${at}.${mac}0`, `${v}.${at}.${mac}.x`,
  ]) {
    assert.equal(await verifyToken(SECRET, PW, bad, NOW), false, String(bad));
  }
});

test("resolveCookieSecret：32字以上の COOKIE_SECRET があればそれ。無いか短ければ合言葉から導いた64字の hex", async () => {
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: SECRET }), SECRET);
  const derived = await resolveCookieSecret({ GATE_PASSWORD: PW });
  assert.match(derived, /^[0-9a-f]{64}$/);
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: "short" }), derived);
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: "" }), derived);
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: PW }), derived); // 毎回同じ
  assert.notEqual(derived, PW);
});

test("導いた鍵で発行・検証でき、合言葉を変えると偽になる（鍵も署名する文も変わる）", async () => {
  const secret = await resolveCookieSecret({ GATE_PASSWORD: PW });
  const t = await issueToken(secret, PW, NOW);
  assert.equal(await verifyToken(secret, PW, t, NOW), true);
  const changed = PW + "x";
  const secret2 = await resolveCookieSecret({ GATE_PASSWORD: changed });
  assert.notEqual(secret2, secret);
  assert.equal(await verifyToken(secret2, changed, t, NOW), false);
  assert.equal(await verifyToken(secret, changed, t, NOW), false); // 鍵だけ古くても偽
  assert.equal(await verifyToken(secret2, PW, t, NOW), false);
});

test("導いた鍵は合言葉の NFC／NFD の違いと前後の空白に左右されない", async () => {
  const nfc = "がぎぐ合言葉-1234567890".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: nfc }), await resolveCookieSecret({ GATE_PASSWORD: nfd }));
  assert.equal(await resolveCookieSecret({ GATE_PASSWORD: ` ${nfc}\n` }), await resolveCookieSecret({ GATE_PASSWORD: nfc }));
});

test("COOKIE_SECRET が32字未満で使われないときは、1回だけ警告する（値は出さない）。32字以上・未設定では出さない", async () => {
  const original = console.warn; const logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  resetSecretWarning();
  try {
    await resolveCookieSecret({ GATE_PASSWORD: PW });
    await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: SECRET });
    assert.deepEqual(logs, []);
    await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: "secret-short-value" });
    await resolveCookieSecret({ GATE_PASSWORD: PW, COOKIE_SECRET: "secret-short-value" });
    assert.equal(logs.length, 1);
    assert.equal(logs[0], "COOKIE_SECRET が32字未満のため使わず、合言葉から鍵を作ります");
    assert.ok(!logs[0].includes("secret-short-value"));
  } finally { console.warn = original; }
});
