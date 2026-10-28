import assert from "node:assert/strict";
import { test } from "node:test";
import { isNameKey, nameKey, normalizeDisplayName, normalizeLinkCode } from "../src/shared/trial-rules.js";
import { base64UrlToBytes, bytesToBase64Url } from "../src/server/bytes";

test("名前は前後の空白を除き、鍵は小文字になる", () => {
  assert.equal(normalizeDisplayName("  Mika  "), "Mika");
  assert.equal(nameKey("Mika"), "mika");
});

test("名前は NFC にそろえる（分解された「か」＋濁点は「が」1字）", () => {
  const decomposed = "が";
  assert.equal(normalizeDisplayName(decomposed), "が");
  assert.equal(nameKey(decomposed.normalize("NFC")), "が");
});

test("20字は可、21字は不可。絵文字は1字と数える", () => {
  assert.equal(normalizeDisplayName("あ".repeat(20)), "あ".repeat(20));
  assert.equal(normalizeDisplayName("あ".repeat(21)), null);
  assert.equal(normalizeDisplayName("😀".repeat(20)), "😀".repeat(20));
  assert.equal(normalizeDisplayName("😀".repeat(21)), null);
});

test("空白だけ・制御文字・ひとりぼっちのサロゲート・文字でない値は不可", () => {
  for (const bad of ["", "   ", "　", "a\u0000b", "a\nb", "\ud800", 123, null, undefined, {}]) assert.equal(normalizeDisplayName(bad), null, String(bad));
});

test("isNameKey は名前の鍵の形だけ通す", () => {
  assert.equal(isNameKey("alice"), true);
  assert.equal(isNameKey("みか"), true);
  for (const bad of ["Alice", " alice", "alice ", "", "a\u0000", "が", "あ".repeat(61), 1, null]) assert.equal(isNameKey(bad), false, String(bad));
});

test("base64url：往復できる／正規でない書き方・不正な文字は null", () => {
  const bytes = new TextEncoder().encode("みか😀");
  const text = bytesToBase64Url(bytes);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(text));
  assert.deepEqual(base64UrlToBytes(text), bytes);
  assert.equal(base64UrlToBytes("QQ="), null);
  assert.equal(base64UrlToBytes("QR"), null); // 余りのビットが0でない（正規は QQ）
  assert.equal(base64UrlToBytes("A"), null);
  assert.equal(base64UrlToBytes(""), null);
  assert.equal(base64UrlToBytes("a+b/"), null);
});

test("書式文字は不可（ゼロ幅空白・向きの制御・ソフトハイフン・BOM）。ゼロ幅接合子は絵文字の組み合わせのために通す", () => {
  for (const bad of ["a\u200bb", "a\u202eb", "a\u00adb", "a\ufeffb", "a\u2060b", "a\u200eb"]) {
    assert.equal(normalizeDisplayName(bad), null, JSON.stringify(bad));
    assert.equal(isNameKey(bad), false, JSON.stringify(bad));
  }
  const family = "👨\u200d👩\u200d👧";
  assert.equal(normalizeDisplayName(family), family);
  assert.equal(isNameKey(family), true);
  assert.equal(normalizeDisplayName("\u200d\u200d"), null); // ゼロ幅接合子だけ（見えない名前）は不可
});

test("ゼロ幅接合子は両側が別の文字のときだけ（先頭・末尾・連続は不可）", () => {
  assert.equal(normalizeDisplayName("a‍b"), "a‍b");
  for (const bad of ["‍ab", "ab‍", "a‍‍b"]) {
    assert.equal(normalizeDisplayName(bad), null, JSON.stringify(bad));
    assert.equal(isNameKey(bad), false, JSON.stringify(bad));
  }
});

test("結合文字・ハングルの埋め字・点字の空白だけの名前は不可。ほかの文字と一緒なら可", () => {
  for (const bad of ["́", "́̂", "ㅤ", "ᅟᅠ", "ﾠ", "⠀", "⠀ㅤ́‍"]) {
    assert.equal(normalizeDisplayName(bad), null, JSON.stringify(bad));
    assert.equal(isNameKey(bad), false, JSON.stringify(bad));
  }
  for (const ok of ["é", "a⠀b", "한글", "⠀a"]) assert.notEqual(normalizeDisplayName(ok), null, JSON.stringify(ok));
});

test("登録できる名前の鍵は、いつも isNameKey を通る（登録できるのに入れない名前が出ない）", () => {
  const samples = ["Mika", "みか", "😀", "👨‍👩‍👧", "İstanbul", "ǅ", "Å", "é", "ΑΣ", "한글", "ｱｲｳ", "a⠀b", "ß", "  x  "];
  for (const name of samples) {
    const display = normalizeDisplayName(name);
    if (display === null) continue;
    assert.equal(isNameKey(nameKey(display)), true, JSON.stringify(name));
  }
});

test("引き継ぎ番号：半角・全角の6桁は通り、5桁・7桁・空白混じり・数字以外・文字でない値は null", () => {
  assert.equal(normalizeLinkCode("123456"), "123456");
  assert.equal(normalizeLinkCode("１２３４５６"), "123456");
  assert.equal(normalizeLinkCode(" 012345 "), "012345");
  assert.equal(normalizeLinkCode("123 456"), "123456");
  assert.equal(normalizeLinkCode("１２３　４５６"), "123456");
  for (const bad of ["12345", "1234567", "12 345", "12345a", "", "١٢٣٤٥٦", 123456, null, undefined]) assert.equal(normalizeLinkCode(bad), null, String(bad));
});
