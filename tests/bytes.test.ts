import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { asciiAt, base64ToBytes } from "../src/server/bytes";

forbidNetwork();

test("base64ToBytes：Buffer の base64 と往復で一致する（0〜300バイト・全バイト値）", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 257, 300]) {
    const source = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
    const b64 = Buffer.from(source).toString("base64");
    assert.deepEqual(base64ToBytes(b64), source, `長さ ${length}`);
  }
});

test("base64ToBytes：空の文字は空のバイト列。結果は Uint8Array", () => {
  const empty = base64ToBytes("");
  assert.ok(empty instanceof Uint8Array);
  assert.equal(empty.length, 0);
});

test("asciiAt：範囲どおりに読み、範囲がバイト列より長ければあるところまで。境目は含まない", () => {
  const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(asciiAt(bytes, 0, 4), "RIFF");
  assert.equal(asciiAt(bytes, 4, 8), "WAVE");
  assert.equal(asciiAt(bytes, 6, 100), "VE");
  assert.equal(asciiAt(bytes, 3, 3), "");
});
