// 利用料の目安（単価・計算・記録係・金額の整形）の試験。外部へは通信しない。記録は node:sqlite（:memory:）の上に作る。
import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { API_PRICING, PRICING_SOURCES, USD_JPY, costUsd, normalizeUsage, providerOf, resolvePricing } from "../src/server/usage/pricing";
import { createUsageStore } from "../src/server/usage/store";
import { jstDate } from "../src/server/time";
import { formatBreakdown, formatPeriod, formatYen } from "../src/client/lib/usage-format.js";
import type { Db } from "../src/server/store/db";
import { migratedDb } from "./helpers/sqlite";

forbidNetwork();

// 実測の usage（2026-10-20）：採点は入力49（文字11・音声38）・出力13・thinking 42、読み上げは入力9・出力71
const gradingUsage = { total_input_tokens: 49, total_output_tokens: 13, total_thought_tokens: 42, total_tokens: 104, input_tokens_by_modality: [{ modality: "text", tokens: 11 }, { modality: "audio", tokens: 38 }] };
const speechUsage = { total_input_tokens: 9, total_output_tokens: 71, total_tokens: 80 };
const FLASH = "gemini-3.8-flash";
const TTS = "gemini-3.8-flash-tts";
const HAIKU = "claude-haiku-5-5";
// Claude の usage（入力900・出力300のうち thinking 120 → 0.00009 + 0.00015 = 0.00024 USD）
const claudeUsage = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 300, output_tokens_details: { thinking_tokens: 120 } };
const in2026 = new Date("2026-10-20T00:00:00Z");
const in2027 = new Date("2027-01-01T00:00:00Z");
const close = (actual: number, expected: number, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} は ${expected} に近いはず`);
const usageDb = () => migratedDb(Date.UTC(2026, 9, 20));
const at = (iso: string) => new Date(iso).getTime();
/** 日の表と累計の表の、モデルごとの値（検算用） */
const rowsOf = (db: Db, table: "usage_days" | "usage_totals") => db.all(`SELECT * FROM ${table} ORDER BY ${table === "usage_days" ? "day, model" : "model"}`);

test("単価は2026年末まで安く、2027-01-01（UTC）から2倍になる", () => {
  const before = new Date("2026-12-31T23:59:59.999Z");
  assert.deepEqual([resolvePricing(FLASH, before).inputPerMTok, resolvePricing(FLASH, before).cachedInputPerMTok, resolvePricing(FLASH, before).outputPerMTok], [0.75, 0.075, 3.75]);
  assert.deepEqual([resolvePricing(FLASH, in2027).inputPerMTok, resolvePricing(FLASH, in2027).cachedInputPerMTok, resolvePricing(FLASH, in2027).outputPerMTok], [1.5, 0.15, 7.5]);
  assert.deepEqual([resolvePricing(TTS, before).inputPerMTok, resolvePricing(TTS, before).outputPerMTok], [0.5, 9]);
  assert.deepEqual([resolvePricing(TTS, in2027).inputPerMTok, resolvePricing(TTS, in2027).outputPerMTok], [1, 18]);
  assert.equal(resolvePricing("gemini-9-pro", in2026), null);
});

test("実測の usage での検算：採点 0.000243 USD、読み上げ 0.0006435 USD、2027年以降は2倍", () => {
  const grading = normalizeUsage(gradingUsage);
  const speech = normalizeUsage(speechUsage);
  close(costUsd(FLASH, grading, in2026), 0.000243);
  close(costUsd(FLASH, grading, in2027), 0.000486);
  close(costUsd(TTS, speech, in2026), 0.0006435);
  close(costUsd(TTS, speech, in2027), 0.001287);
  assert.equal(costUsd("gemini-9-pro", grading, in2026), null);
  close(0.000243 * USD_JPY, 0.037908);
});

test("gemini-3.5-transcribe：実物の usage（音声56+文字1・出力7）の検算は 0.000198 USD で、単価は日付で変わらず、gemini として数える", () => {
  const real = normalizeUsage({ total_input_tokens: 57, input_tokens_by_modality: [{ modality: "text", tokens: 1 }, { modality: "audio", tokens: 56 }], total_output_tokens: 7, total_thought_tokens: 0 });
  close(costUsd("gemini-3.5-transcribe", real, in2026), 0.000198);
  close(costUsd("gemini-3.5-transcribe", real, in2027), 0.000198);
  assert.deepEqual([resolvePricing("gemini-3.5-transcribe", in2026).inputPerMTok, resolvePricing("gemini-3.5-transcribe", in2026).outputPerMTok], [2, 12]);
  assert.equal(providerOf("gemini-3.5-transcribe"), "gemini");
});

test("キャッシュ：入力より多いときは入力に丸め、TTS のキャッシュは入力の単価で数える", () => {
  close(costUsd(FLASH, normalizeUsage({ total_input_tokens: 1000, total_cached_tokens: 400, total_output_tokens: 0 }), in2026), 0.00048);
  close(costUsd(FLASH, normalizeUsage({ total_input_tokens: 1000, total_cached_tokens: 1500, total_output_tokens: 0 }), in2026), (1000 * 0.075) / 1e6);
  close(costUsd(TTS, normalizeUsage({ total_input_tokens: 1000, total_cached_tokens: 400, total_output_tokens: 0 }), in2026), (1000 * 0.5) / 1e6);
});

test("音声の別単価が表に出たときの計算（試験用の表）", () => {
  const table = { m: { regular: { inputPerMTok: 1, audioInputPerMTok: 3, cachedInputPerMTok: 0.1, outputPerMTok: 0 } } };
  const text10audio20 = normalizeUsage({ total_input_tokens: 30, total_output_tokens: 0, input_tokens_by_modality: [{ modality: "text", tokens: 10 }, { modality: "audio", tokens: 20 }] });
  close(costUsd("m", text10audio20, in2026, table), 70e-6);
  const cachedAudio5 = normalizeUsage({ total_input_tokens: 30, total_output_tokens: 0, total_cached_tokens: 5, input_tokens_by_modality: [{ modality: "text", tokens: 10 }, { modality: "audio", tokens: 20 }], cached_tokens_by_modality: [{ modality: "audio", tokens: 5 }] });
  close(costUsd("m", cachedAudio5, in2026, table), 55.5e-6);
});

test("normalizeUsage：欠けは missing、負の数・NaN・文字列は0、モダリティの合計、ツール使用は入力", () => {
  for (const value of [undefined, null, "usage", {}, { total_tokens: "5" }]) {
    const normalized = normalizeUsage(value);
    assert.equal(normalized.missing, true);
    assert.deepEqual([normalized.inputTokens, normalized.audioInputTokens, normalized.cachedTokens, normalized.outputTokens, normalized.thoughtTokens, normalized.toolUseTokens], [0, 0, 0, 0, 0, 0]);
  }
  const odd = normalizeUsage({ total_input_tokens: -5, total_output_tokens: Number.NaN, total_thought_tokens: "3", total_tokens: 1 });
  assert.equal(odd.missing, false);
  assert.deepEqual([odd.inputTokens, odd.outputTokens, odd.thoughtTokens], [0, 0, 0]);
  const byModality = normalizeUsage({ total_tokens: 30, input_tokens_by_modality: [{ modality: "text", tokens: 5 }, { modality: "audio", tokens: 7 }], output_tokens_by_modality: { text: 4, audio: 2 } });
  assert.deepEqual([byModality.inputTokens, byModality.audioInputTokens, byModality.outputTokens], [12, 7, 6]);
  const tool = normalizeUsage({ total_input_tokens: 10, total_output_tokens: 0, total_tool_use_tokens: 20 });
  close(costUsd(FLASH, tool, in2026), (10 * 0.75 + 20 * 0.75) / 1e6);
});

test("jstDate：日本時間の日付で区切る", () => {
  assert.equal(jstDate(Date.parse("2026-10-20T14:59:59.999Z")), "2026-10-20");
  assert.equal(jstDate(Date.parse("2026-10-20T15:00:00.000Z")), "2026-10-21");
});

test("記録係：日本時間の日付ごと・モデルごとに積み、today と total を返す", async () => {
  const db = usageDb();
  let current = at("2026-10-20T14:59:00Z");
  const store = createUsageStore(db, () => current);
  await store.record(FLASH, gradingUsage);
  await store.record(TTS, speechUsage);
  current = at("2026-10-20T15:00:00Z");
  const summary = await store.record(FLASH, gradingUsage);
  assert.equal(summary.today.date, "2026-10-21");
  assert.equal(summary.today.calls, 1);
  close(summary.today.usd, 0.000243);
  assert.equal(summary.total.calls, 3);
  close(summary.total.usd, 0.000243 * 2 + 0.0006435);
  assert.equal(summary.total.since, "2026-10-20");
  close(summary.total.jpy, summary.total.usd * 156);
  assert.equal(summary.usdJpy, 156);
  assert.equal(summary.pricing.checkedOn, "2026-10-20");
  assert.equal(summary.pricing.sources.claude, "https://platform.claude.com/docs/en/about-claude/pricing");
  const days = rowsOf(db, "usage_days");
  assert.deepEqual([...new Set(days.map((row) => row.day))].sort(), ["2026-10-20", "2026-10-21"]);
  const fields = ["audio_input_tokens", "cache_write_1h_tokens", "cache_write_tokens", "cached_tokens", "calls", "day", "input_tokens", "missing_usage_calls", "model", "output_tokens", "thought_tokens", "tool_use_tokens", "unpriced_calls", "usd"];
  for (const row of days) assert.deepEqual(Object.keys(row).sort(), fields);
  const flash = days.find((row) => row.day === "2026-10-20" && row.model === FLASH);
  assert.equal(flash.input_tokens, 49);
  assert.equal(flash.audio_input_tokens, 38);
  assert.equal(flash.thought_tokens, 42);
  assert.equal(store.todayJpy(), 0.000243 * 156);
});

test("記録係：呼んだときの単価で足すので、2027年に単価が上がっても過去の分は変わらない", async () => {
  let current = at("2026-12-31T00:00:00Z");
  const store = createUsageStore(usageDb(), () => current);
  await store.record(FLASH, gradingUsage);
  current = at("2027-01-02T00:00:00Z");
  const summary = await store.record(FLASH, gradingUsage);
  close(summary.total.usd, 0.000243 + 0.000486);
  close(summary.today.usd, 0.000486);
});

test("記録係：usage が欠けた応答は、回数だけ数えて金額は0", async () => {
  const store = createUsageStore(usageDb(), () => in2026.getTime());
  const summary = await store.record(FLASH, undefined);
  assert.deepEqual([summary.total.calls, summary.total.missingUsageCalls, summary.total.usd, summary.total.pricedCalls], [1, 1, 0, 1]);
});

test("記録係：単価の無いモデルは金額に入れず、トークンは数える", async () => {
  const db = usageDb();
  const store = createUsageStore(db, () => in2026.getTime());
  const summary = await store.record("gemini-9-pro", gradingUsage);
  assert.deepEqual([summary.total.calls, summary.total.unpricedCalls, summary.total.pricedCalls, summary.total.usd], [1, 1, 0, 0]);
  assert.equal(formatPeriod(summary.total), "—");
  assert.equal(rowsOf(db, "usage_days").find((row) => row.model === "gemini-9-pro").input_tokens, 49);
  const odd = await store.record("Bad Model!", gradingUsage); // 名前の形が不正なら unknown にまとめる
  assert.equal(odd.total.unpricedCalls, 2);
  assert.ok(rowsOf(db, "usage_days").some((row) => row.model === "unknown"));
});

test("表が空のときの summary は全部0で、行を作らない", async () => {
  const db = usageDb();
  const summary = createUsageStore(db, () => in2026.getTime()).summary();
  assert.deepEqual([summary.today.calls, summary.today.usd, summary.total.calls, summary.total.jpy, summary.total.since], [0, 0, 0, 0, null]);
  assert.equal(rowsOf(db, "usage_days").length, 0);
  assert.equal(rowsOf(db, "usage_totals").length, 0);
  assert.equal(createUsageStore(db, () => in2026.getTime()).todayJpy(), 0);
});

test("途中で例外が起きたら、日の行も累計の行も変わらない（2つ目の書き込みで落ちる Db で確かめる）", async () => {
  const db = usageDb();
  const store = createUsageStore(db, () => in2026.getTime());
  await store.record(FLASH, gradingUsage);
  const before = { days: rowsOf(db, "usage_days"), totals: rowsOf(db, "usage_totals") };
  let writes = 0;
  const failing: Db = {
    all: (q, ...p) => db.all(q, ...p),
    run: (q, ...p) => { writes += 1; if (writes === 2) throw new Error("disk full"); db.run(q, ...p); },
    transaction: (fn) => db.transaction(fn),
  };
  const broken = createUsageStore(failing, () => in2026.getTime());
  assert.throws(() => broken.record(FLASH, gradingUsage), /disk full/);
  assert.deepEqual({ days: rowsOf(db, "usage_days"), totals: rowsOf(db, "usage_totals") }, before);
  assert.equal(store.summary().total.calls, 1);
});

test("20回続けて記録しても、全部数えられる（日の表と累計の表の和が一致する）", async () => {
  const db = usageDb();
  const store = createUsageStore(db, () => in2026.getTime());
  for (let i = 0; i < 20; i += 1) store.record(FLASH, gradingUsage);
  const summary = store.summary();
  assert.equal(summary.total.calls, 20);
  close(summary.total.usd, 0.000243 * 20, 1e-12);
  assert.equal(rowsOf(db, "usage_days")[0].calls, 20);
  assert.equal(rowsOf(db, "usage_totals")[0].calls, 20);
});

test("表の数値が壊れていても（SQL で直に書いた負の数や数でない値）、0として足す", async () => {
  const db = usageDb();
  for (const table of ["usage_days", "usage_totals"] as const) {
    const day = table === "usage_days" ? "'2026-10-20', " : "";
    const columns = table === "usage_days" ? "day, model" : "model";
    db.run(`INSERT INTO ${table} (${columns}, calls, unpriced_calls, usd) VALUES (${day}'${FLASH}', -3, 2, 'x')`);
    db.run(`INSERT INTO ${table} (${columns}, calls, usd) VALUES (${day}'${TTS}', 2, 0.5)`);
  }
  const summary = createUsageStore(db, () => in2026.getTime()).summary();
  assert.deepEqual([summary.total.calls, summary.total.usd, summary.total.unpricedCalls, summary.total.pricedCalls], [2, 0.5, 2, 0]);
  assert.deepEqual([summary.today.calls, summary.today.usd], [2, 0.5]);
});

test("金額の整形", () => {
  assert.equal(formatYen(0), "0円");
  assert.equal(formatYen(0.004), "0.01円未満");
  assert.equal(formatYen(0.138294), "0.14円");
  assert.equal(formatYen(12.34), "12.3円");
  assert.equal(formatYen(1234.5), "1,235円");
  assert.equal(formatYen(Number.NaN), "—");
  assert.equal(formatPeriod({ calls: 0, pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0 }), "0円");
  assert.equal(formatPeriod({ calls: 3, pricedCalls: 3, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0.5 }), "約0.50円");
  assert.equal(formatPeriod({ calls: 3, pricedCalls: 2, unpricedCalls: 1, missingUsageCalls: 0, usd: 0, jpy: 0.5 }), "約0.50円（単価未登録の1回を除く）");
  assert.equal(formatPeriod({ calls: 3, pricedCalls: 0, unpricedCalls: 3, missingUsageCalls: 0, usd: 0, jpy: 0 }), "—");
  assert.ok(Object.isFrozen(API_PRICING));
});

// ---- Claude Haiku 5.5 ----
test("Claude：実物の usage（入力16・出力4・thinking 0）の検算は 0.0000036 USD で、2027年以降も同じ", () => {
  const real = { input_tokens: 16, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4, output_tokens_details: { thinking_tokens: 0 } };
  const normalized = normalizeUsage(real, HAIKU);
  assert.deepEqual([normalized.missing, normalized.inputTokens, normalized.outputTokens, normalized.thoughtTokens], [false, 16, 4, 0]);
  close(costUsd(HAIKU, normalized, in2026), 0.0000036);
  close(costUsd(HAIKU, normalized, new Date("2027-01-02T00:00:00Z")), 0.0000036);
  assert.equal(resolvePricing(HAIKU, in2027).inputPerMTok, 0.10);
});

test("Claude：thinking は output_tokens の内訳として分け、二重に数えない。output を超える thinking は丸める", () => {
  const split = normalizeUsage(claudeUsage, HAIKU);
  assert.deepEqual([split.outputTokens, split.thoughtTokens], [180, 120]);
  close(costUsd(HAIKU, split, in2026), 0.00024); // 入力 0.00009 + 300トークン分の出力 0.00015
  const over = normalizeUsage({ input_tokens: 0, output_tokens: 300, output_tokens_details: { thinking_tokens: 500 } }, HAIKU);
  assert.deepEqual([over.outputTokens, over.thoughtTokens], [0, 300]);
  close(costUsd(HAIKU, over, in2026), 0.00015);
});

test("Claude：キャッシュの書き込み（5分・1時間）と読み取り。内訳が無ければ全部5分として数える", () => {
  const detailed = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 600, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 200 }, output_tokens: 0 }, HAIKU);
  assert.deepEqual([detailed.inputTokens, detailed.cachedTokens, detailed.cacheWriteTokens, detailed.cacheWrite1hTokens], [1700, 1000, 400, 200]);
  close(costUsd(HAIKU, detailed, in2026), 110e-6);
  const flat = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 600, output_tokens: 0 }, HAIKU);
  close(costUsd(HAIKU, flat, in2026), 95e-6);
});

test("Claude：入力の全部が10万トークンを超えると高い単価（境目は超えたときから）", () => {
  close(costUsd(HAIKU, normalizeUsage({ input_tokens: 100000, output_tokens: 1000 }, HAIKU), in2026), 0.0105);
  close(costUsd(HAIKU, normalizeUsage({ input_tokens: 100001, output_tokens: 1000 }, HAIKU), in2026), 0.0525005);
});

test("Claude：usage が欠けたら missing。providerOf は Claude・Gemini・その他を分ける", () => {
  assert.equal(normalizeUsage(undefined, HAIKU).missing, true);
  assert.equal(normalizeUsage({}, HAIKU).missing, true);
  assert.equal(normalizeUsage("x", HAIKU).missing, true);
  assert.deepEqual([providerOf(HAIKU), providerOf(TTS), providerOf(FLASH), providerOf("unknown"), providerOf(undefined)], ["claude", "gemini", "gemini", "other", "other"]);
  assert.equal(normalizeUsage(gradingUsage).cacheWriteTokens, 0); // model を省くと Gemini として読む
  assert.ok(Object.isFrozen(PRICING_SOURCES));
});

test("記録係：Gemini と Claude を分けて数え（byProvider）、単価の無い gemini 系も gemini 側に入り、合計は両方の和", async () => {
  const store = createUsageStore(usageDb(), () => in2026.getTime());
  await store.record(FLASH, gradingUsage);
  await store.record("gemini-9-pro", gradingUsage);
  await store.record(HAIKU, claudeUsage);
  const summary = await store.record("unknown-model", gradingUsage); // other は合計にだけ入る
  assert.equal(summary.today.byProvider.gemini.calls, 2);
  assert.equal(summary.today.byProvider.claude.calls, 1);
  close(summary.today.byProvider.claude.usd, 0.00024);
  close(summary.today.byProvider.gemini.usd, 0.000243);
  assert.equal(summary.total.calls, 4);
  close(summary.total.usd, 0.000243 + 0.00024);
  assert.equal(summary.total.byProvider.gemini.calls + summary.total.byProvider.claude.calls, 3);
});

test("日の表と累計の表の和が一致し、昨日までの Gemini だけの行があっても Claude を記録すると行が足される", async () => {
  const db = usageDb();
  // 昨日までの形：Gemini だけの10欄（日の表・累計の表とも）
  db.run(`INSERT INTO usage_days (day, model, calls, input_tokens, audio_input_tokens, output_tokens, thought_tokens, usd) VALUES ('2026-10-20', '${FLASH}', 3, 100, 50, 20, 10, 0.0007)`);
  db.run(`INSERT INTO usage_totals (model, calls, usd) VALUES ('${FLASH}', 3, 0.0007)`);
  const store = createUsageStore(db, () => in2026.getTime());
  const before = store.summary();
  assert.equal(before.total.calls, 3);
  assert.equal(before.total.byProvider.claude.calls, 0);
  assert.equal(before.total.byProvider.gemini.calls, 3);
  const after = await store.record(HAIKU, claudeUsage);
  assert.equal(after.total.byProvider.claude.calls, 1);
  close(after.total.usd, 0.0007 + 0.00024);
  const haiku = rowsOf(db, "usage_days").find((row) => row.model === HAIKU);
  assert.equal(haiku.input_tokens, 900);
  assert.equal(haiku.thought_tokens, 120);
  assert.equal(rowsOf(db, "usage_days").find((row) => row.model === FLASH).usd, 0.0007);
  await store.record(FLASH, gradingUsage);
  await store.record(TTS, speechUsage);
  // 累計の表は、日の表のモデルごとの和と一致する
  const sums = db.all("SELECT model, SUM(calls) AS calls, SUM(usd) AS usd FROM usage_days GROUP BY model ORDER BY model");
  const totals = db.all("SELECT model, calls, usd FROM usage_totals ORDER BY model");
  assert.equal(sums.length, totals.length);
  sums.forEach((row, i) => { assert.equal(row.model, totals[i].model); assert.equal(row.calls, totals[i].calls); close(Number(row.usd), Number(totals[i].usd)); });
});

test("内訳の整形", () => {
  const zero = { calls: 0, pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0 };
  assert.equal(formatBreakdown(undefined), "");
  assert.equal(formatBreakdown({ gemini: zero, claude: zero }), "Gemini 0円・Claude 0円");
  assert.equal(formatBreakdown({ gemini: { calls: 3, pricedCalls: 3, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0.5 }, claude: { calls: 2, pricedCalls: 2, unpricedCalls: 0, missingUsageCalls: 0, usd: 0, jpy: 0.04 } }), "Gemini 約0.50円・Claude 約0.04円");
});

test("formatDaily：回答・読み上げの回数と円の使用量／上限。dailyReached は1つでも達していれば真", async () => {
  const { formatDaily, dailyReached } = await import("../src/client/lib/usage-format.js");
  const daily = { answers: { used: 12, limit: 300 }, speech: { used: 3, limit: 100 }, yen: { used: 1.234, limit: 50 }, reached: { answers: false, speech: false, yen: false } };
  assert.equal(formatDaily(daily), "回答 12/300回・読み上げ 3/100回・約1.23円/50円");
  assert.equal(formatDaily({ ...daily, yen: { used: 0, limit: 50 } }), "回答 12/300回・読み上げ 3/100回・約0円/50円");
  assert.equal(dailyReached(daily), false);
  assert.equal(dailyReached({ ...daily, reached: { ...daily.reached, speech: true } }), true);
  assert.equal(dailyReached({ ...daily, reached: { answers: false, speech: false, yen: true } }), true);
});
