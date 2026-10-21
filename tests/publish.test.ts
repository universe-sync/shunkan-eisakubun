// 公開してよい状態かの試験。リポジトリに入るファイルに、個人の情報・秘密が無いことと、Deploy ボタン用の設定がそろっていること
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { ROOT } from "./helpers/fakes";
import { localForbidden } from "./helpers/local-forbidden";

forbidNetwork();

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".git"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?)$/i;
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}
// このテスト自身も検査する。禁止の形は文字の組み合わせで作り、この文章に同じ形が現れないようにしている
const re = (...parts: string[]): RegExp => new RegExp(parts.join(""));
const targets = files(ROOT).filter((file) => !BINARY.test(file) && !/(^|\/)\.dev\.vars$/.test(file) && !/(^|\/)\.env/.test(file) && !/(^|\/)tests\/[^/]*\.local\.json$/.test(file));

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["個人のパス（Mac）", re("/Us", "ers/")],
  ["個人のパス（Linux）", re("/ho", "me/")],
  ["Google のプロジェクト ID", re("gen-lang-", "client-")],
  ["Claude のワークスペース ID", re("wrk", "spc_")],
  ["Google のキー（AIza…）", re("AI", "za[0-9A-Za-z_-]{35}")],
  ["Google のキー（AQ.…）", re("AQ", "\\.[0-9A-Za-z_-]{20,}")],
  ["Anthropic のキー", re("sk-", "ant-[A-Za-z0-9_-]{10,}")],
];
// 置き換え用の形（<…>・&lt;…&gt;）か example を含む workers.dev の URL だけを許す
const WORKERS_DEV = re("[^\\s\"'`)(]*\\.work", "ers\\.dev");
const WORKERS_DEV_OK = /<|&lt;|example/i;
// メールアドレスの形。許可するのは、ダミーの .example ドメインと example.com / example.org だけ（試験の入力例）。実在のものは許可リストに書く（いまは無し）
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_ALLOWED: readonly string[] = [];
const DUMMY_MAIL = /@([A-Za-z0-9-]+\.)*example(\.(com|org))?$/i;

test("リポジトリに入るファイルに、個人の情報・キーらしい文字列・作者の URL・メールアドレスが無い", () => {
  assert.ok(targets.length > 50, `見る対象が少なすぎる: ${targets.length}`);
  for (const file of targets) {
    const name = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    for (const [label, pattern] of FORBIDDEN) assert.doesNotMatch(text, pattern, `${name} に${label}`);
    for (const url of text.match(new RegExp(WORKERS_DEV.source, "g")) ?? []) assert.ok(WORKERS_DEV_OK.test(url), `${name} に置き換え用でない workers.dev の URL: ${url}`);
    for (const mail of text.replace(/https?:\/\/[^\s"'`]*/g, "").match(EMAIL) ?? []) // URL の中の user@host は、メールアドレスとして数えない
      assert.ok(EMAIL_ALLOWED.includes(mail) || DUMMY_MAIL.test(mail), `${name} にメールアドレス: ${mail}`);
  }
});

test("手元の禁止語（tests/publish-forbidden.local.json）がリポジトリに無い。ファイルが無ければ、ローカルの禁止語なしで続ける", () => {
  const words = localForbidden();
  if (words.length === 0) console.log("ローカルの禁止語なしで続けます（tests/publish-forbidden.local.json が無いか空）");
  for (const file of targets) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const word of words) assert.ok(!text.includes(word.toLowerCase()), `${relative(ROOT, file)} に手元の禁止語が含まれている（番号 ${words.indexOf(word) + 1}）`);
  }
});

test("README・手順のページ・LICENSE・CLAUDE.md が入っていて、Deploy ボタンの行き先は公開先のリポジトリ", () => {
  for (const name of ["README.md", "docs/index.html", "LICENSE", "CLAUDE.md"]) assert.ok(statSync(join(ROOT, name)).isFile(), name);
  const url = "https://deploy.workers.cloudflare.com/?url=https://github.com/universe-sync/speak25";
  assert.ok(readFileSync(join(ROOT, "README.md"), "utf8").includes(url));
  assert.ok(readFileSync(join(ROOT, "docs/index.html"), "utf8").includes(url));
  assert.match(readFileSync(join(ROOT, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 universe-sync/);
});

test("手順のページに外部の読み込み（script・link・img・外部の CSS）が無く、スマホ用の指定がある", () => {
  const html = readFileSync(join(ROOT, "docs/index.html"), "utf8");
  assert.doesNotMatch(html, /<script|<link|<img|@import|url\(/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test("package.json の cloudflare.bindings が .dev.vars.example の有効な項目とそろい、description がある", () => {
  const p = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(typeof p.description === "string" && p.description.length > 0);
  const active = readFileSync(join(ROOT, ".dev.vars.example"), "utf8").split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")).map((line) => line.split("=")[0]);
  assert.deepEqual(Object.keys(p.cloudflare.bindings).sort(), [...active].sort());
  for (const [name, value] of Object.entries<{ description?: string }>(p.cloudflare.bindings)) assert.ok(value.description && value.description.length > 0, name);
});
