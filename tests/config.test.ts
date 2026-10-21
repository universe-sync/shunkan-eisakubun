// 設定ファイルの試験（wrangler.jsonc・package.json・.dev.vars.example・.gitignore・index.html）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_NAME } from "../src/shared/app-info.js";
import { forbidNetwork } from "./helpers/no-network";
import { ROOT } from "./helpers/fakes";

forbidNetwork();
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");

// wrangler.jsonc の注意書きは「行の頭の // 」だけ（行の途中にコメントを書かない）
function wrangler(): any {
  const text = read("wrangler.jsonc").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  return JSON.parse(text);
}

test("wrangler.jsonc：名前・入口・互換日付・フラグ・assets・DO・移行・ポート", () => {
  const w = wrangler();
  assert.equal(w.name, "speak25");
  assert.equal(w.main, "src/server/worker.ts");
  assert.equal(w.compatibility_date, "2026-08-15");
  assert.deepEqual(w.compatibility_flags, ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"]);
  assert.equal(w.workers_dev, true);
  assert.equal(w.preview_urls, false);
  assert.equal(w.send_metrics, false);
  assert.deepEqual(w.assets, { directory: "./dist/client", binding: "ASSETS", run_worker_first: true, html_handling: "auto-trailing-slash", not_found_handling: "none" });
  assert.deepEqual(w.durable_objects, { bindings: [{ name: "PRACTICE", class_name: "PracticeDO" }] });
  assert.deepEqual(w.migrations, [{ tag: "v1", new_sqlite_classes: ["PracticeDO"] }]);
  assert.deepEqual(w.dev, { port: 8820, inspector_port: 9820 });
  assert.deepEqual(w.observability, { enabled: true });
});

test("wrangler.jsonc の vars：1日の上限・頻度制限の5つだけで、値は数字の文字列。秘密（KEY・SECRET・PASSWORD）の名前が無い", () => {
  const w = wrangler();
  assert.deepEqual(w.vars, { DAILY_ANSWER_LIMIT: "300", DAILY_YEN_LIMIT: "50", DAILY_SPEECH_LIMIT: "100", RATE_ANSWER_PER_MINUTE: "40", RATE_SPEECH_PER_MINUTE: "30" });
  for (const [name, value] of Object.entries<string>(w.vars)) {
    assert.match(value, /^\d{1,6}$/, name);
    assert.ok(!/(KEY|SECRET|PASSWORD|TOKEN)/i.test(name), name);
  }
});

test("package.json：版がすべて固定（^・~・latest なし）で、deploy は build してから wrangler deploy。Node は22.12以上", () => {
  const p = JSON.parse(read("package.json"));
  for (const group of [p.dependencies, p.devDependencies]) {
    for (const [name, version] of Object.entries<string>(group)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: ${version}`);
    }
  }
  assert.equal(p.scripts.deploy, "vite build && wrangler deploy");
  const deployCommands = Object.entries<string>(p.scripts).filter(([, command]) => /wrangler deploy(?!\s+--dry-run)/.test(command)).map(([name]) => name);
  assert.deepEqual(deployCommands, ["deploy"], "deploy 以外に、dry-run でない wrangler deploy がある");
  assert.equal(p.engines.node, ">=22.12");
  assert.equal(p.name, "speak25");
  assert.equal(p.private, true);
});

test(".dev.vars.example：項目名と説明だけで、値が全部空。COOKIE_SECRET は任意なのでコメント", () => {
  const text = read(".dev.vars.example");
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
  assert.deepEqual(lines.map((line) => line.split("=")[0]), ["GATE_PASSWORD", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"]);
  for (const line of lines) assert.equal(line.slice(line.indexOf("=") + 1), "", line);
  assert.match(text, /^# COOKIE_SECRET=$/m);
});

test(".gitignore：秘密・生成物・依存を外している", () => {
  const lines = read(".gitignore").split("\n").map((line) => line.trim());
  for (const needed of [".dev.vars", ".dev.vars.*", "!.dev.vars.example", ".env*", ".wrangler/", "dist/", "node_modules/", "data/"]) {
    assert.ok(lines.includes(needed), `${needed} が .gitignore に無い`);
  }
});

test("index.html の title が APP_NAME と同じで、noindex とアイコンの指定がある", () => {
  const html = read("index.html");
  assert.equal(html.match(/<title>([^<]*)<\/title>/)?.[1], APP_NAME);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="speak25"\/>/);
  for (const icon of ["/icon.svg", "/icon-32.png", "/apple-touch-icon.png"]) assert.ok(html.includes(`href="${icon}"`), icon);
  assert.ok(html.includes('src="/src/client/main.tsx"'));
});
