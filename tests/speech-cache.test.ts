import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechCache, speechKey } from "../src/client/lib/speech-cache";

const blob = (n: number) => new Blob([String(n)]);

test("speechKey：模範文は reference、直した文は回答の ID、最後に速さ", () => {
  assert.equal(speechKey("q001", undefined, "normal"), "q001:reference:normal");
  assert.equal(speechKey("q001", "a1", "normal"), "q001:a1:normal");
  assert.equal(speechKey("q001", "", "slow"), "q001:reference:slow");
  assert.notEqual(speechKey("q001", "a1", "normal"), speechKey("q001", "a1", "slow"));
});

test("上限を超えると古いものから消え、get で新しい側へ移る", () => {
  const cache = createSpeechCache(3);
  cache.set("a", blob(1)); cache.set("b", blob(2)); cache.set("c", blob(3));
  assert.ok(cache.get("a")); // a が新しくなる
  cache.set("d", blob(4)); // いちばん古い b が消える
  assert.equal(cache.get("b"), undefined);
  assert.ok(cache.get("a") && cache.get("c") && cache.get("d"));
  assert.equal(cache.size, 3);
});

test("clear で全部消える。同じキーの set は入れ替え", () => {
  const cache = createSpeechCache();
  const first = blob(1); const second = blob(2);
  cache.set("a", first); cache.set("a", second);
  assert.equal(cache.get("a"), second);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});
