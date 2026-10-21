// 画面のコードに、.env.local の名残や、手元の禁止語（tests/publish-forbidden.local.json）が残っていないことの試験
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { forbidNetwork } from "./helpers/no-network";
import { ROOT } from "./helpers/fakes";
import { localForbidden } from "./helpers/local-forbidden";

forbidNetwork();

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

test("src/client に、.env.local が残っていない（ローカルの禁止語があればそれも）。キーの案内は Cloudflare の文言", () => {
  const targets = files(join(ROOT, "src", "client"));
  assert.ok(targets.length >= 10);
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    const local = localForbidden();
    for (const gone of [".env.local", ...local]) {
      assert.ok(!text.includes(gone), `${relative(ROOT, file)} に、${gone === ".env.local" ? ".env.local" : `手元の禁止語（番号 ${local.indexOf(gone) + 1}）`}が残っている`);
    }
  }
  const strings = readFileSync(join(ROOT, "src", "client", "strings.ts"), "utf8");
  assert.match(strings, /Cloudflare のダッシュボード（Workers & Pages → このアプリ → Settings → Variables and Secrets）に Secret として登録してください（手元の wrangler dev では \.dev\.vars に書きます）/);
});
