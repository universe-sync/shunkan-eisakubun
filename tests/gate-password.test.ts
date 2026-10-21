import assert from "node:assert/strict";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { equalBytes, passwordMatches } from "../src/server/gate/password";

forbidNetwork();

test("同じなら真、違えば偽（1 字違い・長さ違い）", async () => {
  assert.equal(await passwordMatches("abcdef", "abcdef"), true);
  assert.equal(await passwordMatches("abcdeg", "abcdef"), false);
  assert.equal(await passwordMatches("abcde", "abcdef"), false);
  assert.equal(await passwordMatches("abcdefg", "abcdef"), false);
});

test("空の入力は偽（正解が空でも）", async () => {
  assert.equal(await passwordMatches("", "abc"), false);
  assert.equal(await passwordMatches("", ""), false);
});

test("日本語の合言葉は NFC と NFD で同じ扱い", async () => {
  const nfc = "がぎぐ合言葉".normalize("NFC");
  const nfd = "がぎぐ合言葉".normalize("NFD");
  assert.notEqual(nfc, nfd);
  assert.equal(await passwordMatches(nfd, nfc), true);
  assert.equal(await passwordMatches(nfc, nfd), true);
});

test("前後の空白は削らない", async () => {
  assert.equal(await passwordMatches(" abc", "abc"), false);
});

test("equalBytes の基本", () => {
  assert.equal(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  assert.equal(equalBytes(new Uint8Array([]), new Uint8Array([])), true);
});
