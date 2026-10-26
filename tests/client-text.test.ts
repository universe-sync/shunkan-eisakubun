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

test("瞬間英作文の画面：1問の時間は4つのボタンだけで、説明文は指示どおり。「制限なし」は出さない", () => {
  const source = readFileSync(join(ROOT, "src", "client", "InstantPractice.tsx"), "utf8");
  assert.ok(source.includes("QUESTION_SECONDS_PRESETS.map"));
  assert.doesNotMatch(source, /制限なし|NO_LIMIT|時間の制限はありません|最長\$\{/);
  assert.ok(source.includes("const timeNote = `${questionSeconds}秒たつと自動で次の問題へ進みます。`;"));
  assert.doesNotMatch(source, /1秒ずつ|次に開いたときも使います/);
  assert.ok(source.includes("`まだクリアしていない問題から${questionCount}問出します。`"));
  assert.doesNotMatch(source, /料金の目安|長く話すほど/);
});

test("画面のコード：読み上げの音声の使い回しと、履歴のスクロール、今日の回答のタイル", () => {
  const text = readFileSync(join(ROOT, "src", "client", "InstantPractice.tsx"), "utf8");
  assert.ok(text.includes("speechKey("));
  assert.ok(text.includes("speechCache.current.clear()"));
  assert.ok(text.includes("historySection.current?.scrollIntoView"));
  assert.ok(text.includes("prefers-reduced-motion: reduce"));
  assert.ok(text.includes("今日の回答"));
});

test("お試しの文は「問題数は選べます」と言わない（1問の時間だけ）。1人用の文は今のまま", () => {
  const text = readFileSync(join(ROOT, "src", "client", "InstantPractice.tsx"), "utf8");
  assert.ok(text.includes("スタートすると録音が始まります。1問の時間は、上の欄で選べます（お試しは1回10問です）。"));
  assert.ok(text.includes("スタートすると録音が始まります。1問の時間と問題数は、上の欄で選べます。")); // 1人用
  assert.ok(text.includes("1問の時間を10〜30秒から選べます（お試しは1回10問です）。"));
  assert.ok(text.includes("1問の時間を10〜30秒、1回の問題数を10・20・30・50問から選べます。"));
  assert.ok(text.includes("設定した時間がたつと自動で次の問題へ進みます。"));
  assert.ok(text.includes("設定した時間を待たずに次へ進めます。"));
  assert.doesNotMatch(text, /1問\$\{questionSeconds\}秒で次の問題へ進みます/);
  for (const need of ['(trial ? "1問の時間を保存できませんでした', '(trial ? "1問の時間の設定を読み込めませんでした', '{trial ? "1問の時間" : "1問の時間と問題数"}は、出題中は変えられません', 'trialRef.current ? "1問の時間" : "1問の時間と問題数"', "{!trialBlocked && <button", "お試しのきまり"]) assert.ok(text.includes(need), need);
  const strings = readFileSync(join(ROOT, "src", "client", "strings.ts"), "utf8");
  assert.ok(!/お試し[^"]*問題数は[^"]*選べ/.test(strings));
});

test("設定の失敗は種類だけを state に持ち、文は描くときに trial を見て決める（status より先に失敗が返っても、お試しの文になる）", () => {
  const text = readFileSync(join(ROOT, "src", "client", "InstantPractice.tsx"), "utf8");
  assert.ok(text.includes('useState<"" | "load" | "save">("")'));
  assert.ok(text.includes('setSettingsNote("load")') && text.includes('setSettingsNote("save")'));
  assert.ok(text.includes("{settingsNoteText}"));
  assert.ok(!/setSettingsNote\(trialRef/.test(text));
});

test("数字のタイル：今日の平均・全体の平均は、項目が応答にあるときだけ出し、小数第1位＋「点」、null は「–」", () => {
  const text = readFileSync(join(ROOT, "src", "client", "InstantPractice.tsx"), "utf8");
  assert.ok(text.includes('const scoreText = (value: number | null | undefined) => typeof value === "number" ? `${value.toFixed(1)} 点` : "–"'));
  assert.ok(text.includes("summary && summary.todayAverage !== undefined && <span>今日の平均 <strong>{scoreText(summary.todayAverage)}</strong></span>"));
  assert.ok(text.includes("summary && summary.averageScore !== undefined && <span>全体の平均 <strong>{scoreText(summary.averageScore)}</strong></span>"));
  assert.ok(text.indexOf("今日の回答") < text.indexOf("今日の平均") && text.indexOf("今日の平均") < text.indexOf("全体の平均"));
});
