// お試しモードの名前の決まり（Worker・DO・画面で同じものを使う）
export const NAME_MAX_CHARS = 20;
export const TRIAL_SESSION_SIZE = 10;
export const NAME_RULE_MESSAGE = "名前は1〜20文字で入れてください（空白だけや制御文字は使えません）。";
export const NAME_TAKEN_MESSAGE = "その名前はすでに使われています。別の名前にしてください。";
// 制御文字・ひとりぼっちのサロゲート・書式文字（ゼロ幅空白・向きの制御・ソフトハイフン・BOM など）。ゼロ幅接合子 U+200D だけは絵文字の組み合わせに要るので通す
const BAD = /(?!\u200d)[\p{Cc}\p{Cs}\p{Cf}]/u;
// U+200D は両側が U+200D 以外の文字のときだけ（先頭・末尾・連続は不可）
const BAD_JOINER = /^\u200d|\u200d$|\u200d\u200d/;
// 結合文字・ハングルの埋め字（U+3164・U+115F・U+1160・U+FFA0）・点字の空白（U+2800）・U+200D だけでできた名前は、見えない名前になるので不可
const INVISIBLE_ONLY = /^[\p{M}\u3164\u115f\u1160\uffa0\u2800\u200d]+$/u;
const shapeOk = (s) => !BAD.test(s) && !BAD_JOINER.test(s) && !INVISIBLE_ONLY.test(s);

/** 正しければ表示名（NFC・前後の空白なし）、だめなら null */
export function normalizeDisplayName(input) {
  if (typeof input !== "string") return null;
  const s = input.normalize("NFC").trim();
  const n = [...s].length;
  if (n < 1 || n > NAME_MAX_CHARS || !shapeOk(s)) return null;
  return s;
}
/** 表示名 → 名前の鍵（大文字と小文字は区別しない。NFC のまま） */
export function nameKey(display) { return display.toLowerCase().normalize("NFC"); }
/** X-User-Key・cookie から戻した値が、名前の鍵の形か */
export function isNameKey(value) {
  return typeof value === "string" && value !== "" && value === value.trim() && [...value].length <= NAME_MAX_CHARS * 3
    && shapeOk(value) && value.normalize("NFC") === value && nameKey(value) === value;
}
