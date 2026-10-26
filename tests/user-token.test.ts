import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToBase64Url } from "../src/server/bytes";
import { decodeUserKey, encodeUserKey, issueUserToken, verifyUserToken } from "../src/server/gate/user-token";

const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);
const SECRET = "s".repeat(40);
const DAY = 24 * 3600_000;

test("発行→検証で鍵が戻る（日本語・絵文字も）", async () => {
  for (const key of ["alice", "みか", "😀ゆう"]) {
    assert.equal(await verifyUserToken(SECRET, await issueUserToken(SECRET, key, NOW), NOW + 1000), key);
  }
});

test("null：署名1字違い・181日前・61秒より先・違う鍵・形違い", async () => {
  const token = await issueUserToken(SECRET, "alice", NOW);
  const last = token.slice(-1) === "0" ? "1" : "0";
  assert.equal(await verifyUserToken(SECRET, token.slice(0, -1) + last, NOW), null);
  assert.equal(await verifyUserToken(SECRET, token, NOW + 181 * DAY), null);
  assert.equal(await verifyUserToken(SECRET, token, NOW + 179 * DAY), "alice");
  assert.equal(await verifyUserToken(SECRET, token, NOW - 61_000), null);
  assert.equal(await verifyUserToken(SECRET, token, NOW - 59_000), "alice");
  assert.equal(await verifyUserToken("x".repeat(40), token, NOW), null);
  for (const bad of ["", "u1.a.b.c", "v1." + token.slice(3), undefined, null]) assert.equal(await verifyUserToken(SECRET, bad as string, NOW), null);
});

test("署名が正しくても、中身が鍵の形でなければ null（大文字・空白）", async () => {
  for (const key of ["Alice", " alice", "alice "]) assert.equal(await verifyUserToken(SECRET, await issueUserToken(SECRET, key, NOW), NOW), null, key);
});

test("decodeUserKey は不正・正規でない base64url・UTF-8 でないバイト列を断る", () => {
  assert.equal(decodeUserKey(encodeUserKey("みか")), "みか");
  assert.equal(decodeUserKey(null), null);
  assert.equal(decodeUserKey(undefined), null);
  assert.equal(decodeUserKey(""), null);
  assert.equal(decodeUserKey("***"), null);
  assert.equal(decodeUserKey(encodeUserKey("alice") + "="), null);
  assert.equal(decodeUserKey(bytesToBase64Url(Uint8Array.from([0xff, 0xfe, 0x41]))), null);
  assert.equal(decodeUserKey(encodeUserKey("Alice")), null);
});
