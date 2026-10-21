// 秘密情報がコードに入っていないことの試験。キーらしい文字列を探す。.dev.vars・.env* は開かない
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { ROOT } from "./helpers/fakes";

forbidNetwork();

const SKIP = new Set(["node_modules", "dist", ".wrangler", ".git"]);
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}
const TEXT = /\.(ts|tsx|js|json|jsonc|html|css|svg|md|example)$/;

test("src・tests・public・index.html・設定ファイルに、Anthropic・Gemini のキーらしい文字列が無い", () => {
  const targets = [
    ...files(join(ROOT, "src")), ...files(join(ROOT, "tests")), ...files(join(ROOT, "public")), ...files(join(ROOT, "scripts")),
    ...["index.html", "package.json", "wrangler.jsonc", "tsconfig.json", "tsconfig.client.json", "tsconfig.node.json", "vite.config.ts", ".dev.vars.example", "CLAUDE.md"].map((name) => join(ROOT, name)),
  ].filter((file) => existsSync(file) && TEXT.test(file));
  assert.ok(targets.length > 40, `見る対象が少なすぎる: ${targets.length}`);
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{10,}/, `${relative(ROOT, file)} に Anthropic のキーらしい文字列`);
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/, `${relative(ROOT, file)} に Google のキーらしい文字列`);
  }
});

test("プロジェクトの中に .env* と data/ が無く、.dev.vars は中身の確認をしない（存在だけを見る）", () => {
  const names = readdirSync(ROOT);
  assert.ok(!names.some((name) => name.startsWith(".env")), ".env* がある");
  assert.ok(!names.includes("data"), "data/ がある");
  // .dev.vars はオーナーが手元で作る。あっても開かない（git の対象外は config.test.ts で確かめる）
});
