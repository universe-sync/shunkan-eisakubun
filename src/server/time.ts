/** UTC の ISO 文字列（秒まで・Z）。例 "2026-10-18T06:00:00Z"。ミリ秒は切り捨てる */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
/** UTC の ISO 文字列（ミリ秒まで） */
export function isoMillis(ms: number): string {
  return new Date(ms).toISOString();
}
/** 日本時間の日付（夏時間は無い）。例 "2026-10-21" */
export function jstDate(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}
