// 手元だけの禁止語（個人の名前・アカウント・URL など）。公開するリポジトリに書かないため、git に入れないファイルから読む。
// ファイル：tests/publish-forbidden.local.json  例 {"patterns": ["語1", "語2"]}（大文字小文字は区別しない部分一致）。無ければ空
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fakes";

export const LOCAL_FORBIDDEN_FILE = join(ROOT, "tests", "publish-forbidden.local.json");

export function localForbidden(): string[] {
  if (!existsSync(LOCAL_FORBIDDEN_FILE)) return [];
  const value = JSON.parse(readFileSync(LOCAL_FORBIDDEN_FILE, "utf8"));
  const list: unknown = value?.patterns;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x !== "")) throw new Error("publish-forbidden.local.json は {\"patterns\": [\"語\", ...]} の形にしてください");
  return list as string[];
}
