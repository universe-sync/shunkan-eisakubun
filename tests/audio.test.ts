import { forbidNetwork } from "./helpers/no-network";
forbidNetwork();
import test from "node:test";
import assert from "node:assert/strict";
import { SPEECH_DETECTION, SPEECH_WAV_FORMAT, detectSpeech, frameLevelsDbfs, inspectSpeechWav, parseWav } from "../src/shared/audio.js";
import { encodeWavPcm16, mixToMono } from "../src/client/lib/wav.js";
import { buildWav, clicks, concat, noise, silence, speechLike, toWav } from "./helpers/wav-fixtures";

const detect = (samples) => detectSpeech(Int16Array.from(samples as ArrayLike<number>, (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32768)))), 16000);
const fmt = (d) => `${d.hasSpeech} voiced=${d.voicedSec.toFixed(2)} run=${d.longestRunSec.toFixed(2)}`;
const wavError = (code) => ({ name: "WavFormatError", code, status: 400 });

test("encodeWavPcm16 の出力を parseWav で読み戻せる", () => {
  const samples = Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 7) * 0.4);
  const buffer = encodeWavPcm16(samples, 16000);
  assert.equal(buffer.byteLength, 44 + 1600);
  const bytes = Buffer.from(buffer);
  assert.equal(bytes.readUInt32LE(4), 36 + 1600);
  const wav = parseWav(bytes);
  assert.equal(wav.sampleRate, 16000); assert.equal(wav.channels, 1); assert.equal(wav.bitsPerSample, 16);
  assert.equal(wav.samples.length, 800);
  samples.forEach((v, i) => assert.equal(wav.samples[i], Math.round(v < 0 ? v * 32768 : v * 32767)));
});

test("encodeWavPcm16 は範囲外を丸め、NaN は 0 にする。mixToMono は平均する", () => {
  const wav = parseWav(Buffer.from(encodeWavPcm16(Float32Array.from([1.5, -1.5, NaN]), 16000)));
  assert.deepEqual([...wav.samples], [32767, -32768, 0]);
  assert.deepEqual([...mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, 0.5])])], [0.5, 0.5]);
  assert.equal(mixToMono([]).length, 0);
});

test("不明なチャンクを読み飛ばし、data が fmt より前でも読める", () => {
  const data = Buffer.alloc(3200, 0);
  const a = parseWav(buildWav({ data, before: [["LIST", Buffer.alloc(7, 1)], ["FLLR", Buffer.alloc(4044)]] }));
  assert.equal(a.samples.length, 1600);
  const b = parseWav(buildWav({ data, dataFirst: true }));
  assert.equal(b.samples.length, 1600);
});

test("壊れたヘッダーは WavFormatError（400）", () => {
  assert.throws(() => parseWav(Buffer.alloc(8)), wavError("not_wav"));
  assert.throws(() => parseWav(buildWav({ riff: "RIFX", data: Buffer.alloc(100) })), wavError("not_wav"));
  assert.throws(() => parseWav(buildWav({ wave: "AVI ", data: Buffer.alloc(100) })), wavError("not_wav"));
  assert.throws(() => parseWav(buildWav({ omitFmt: true, data: Buffer.alloc(100) })), wavError("missing_fmt"));
  assert.throws(() => parseWav(buildWav({ omitData: true })), wavError("missing_data"));
  assert.throws(() => parseWav(buildWav({ fmtSize: 14, data: Buffer.alloc(100) })), wavError("bad_fmt"));
  assert.throws(() => parseWav(buildWav({ data: Buffer.alloc(100), declaredDataSize: 5000 })), wavError("truncated"));
  assert.throws(() => parseWav(buildWav({ data: Buffer.alloc(0) })), wavError("empty"));
});

test("PCM 16bit 以外は unsupported_encoding", () => {
  assert.throws(() => parseWav(buildWav({ formatTag: 3, bitsPerSample: 32, data: Buffer.alloc(64000) })), wavError("unsupported_encoding"));
  assert.throws(() => parseWav(buildWav({ bitsPerSample: 8, data: Buffer.alloc(16000) })), wavError("unsupported_encoding"));
});

test("inspectSpeechWav は 16kHz・モノラル・65秒以内だけ通す（1区間の録音は最長60秒＋余裕5秒）", () => {
  assert.throws(() => inspectSpeechWav(buildWav({ channels: 2, data: Buffer.alloc(64000) })), wavError("unsupported_format"));
  assert.throws(() => inspectSpeechWav(buildWav({ sampleRate: 44100, data: Buffer.alloc(88200) })), wavError("unsupported_format"));
  assert.ok(inspectSpeechWav(toWav(silence(60))));
  assert.ok(inspectSpeechWav(toWav(silence(65))));
  assert.throws(() => inspectSpeechWav(toWav(silence(65.5))), (error: any) => error.code === "too_long" && /1問の録音は60秒まで/.test(error.message));
  assert.equal(SPEECH_WAV_FORMAT.maxDurationSec, 65);
  assert.ok(inspectSpeechWav(toWav(speechLike())).detection.hasSpeech);
});

test("frameLevelsDbfs は正弦波で約 -9.03 dBFS、直流だけなら -120", () => {
  const sine = Int16Array.from({ length: 4800 }, (_, i) => Math.round(0.5 * 32768 * Math.sin(2 * Math.PI * 440 * i / 16000)));
  for (const level of frameLevelsDbfs(sine, 16000, 30)) assert.ok(Math.abs(level - -9.03) < 0.2, String(level));
  for (const level of frameLevelsDbfs(new Int16Array(960).fill(1000), 16000, 30)) assert.equal(level, -120);
});

test("完全な無音、小さな雑音、定常雑音は声なし", () => {
  const cases = { 無音: silence(2.2), "σ=120": noise(3, 120, 7), "σ=400": noise(3, 400, 7), "無音0.5秒+σ=400": concat(silence(0.5), noise(2.5, 400, 8)) };
  for (const [name, samples] of Object.entries(cases)) { const d = detect(samples); assert.equal(d.hasSpeech, false, `${name}: ${fmt(d)}`); }
  assert.equal(detect(silence(2.2)).voicedSec, 0);
});

test("音声らしい信号は声あり。-20 dB は声あり、-30 dB は声なし", () => {
  const normal = detect(speechLike());
  assert.ok(normal.hasSpeech && normal.voicedSec >= 0.6 && normal.longestRunSec >= 0.12, fmt(normal));
  const quiet = detect(speechLike({ gainDb: -20 })); assert.ok(quiet.hasSpeech, fmt(quiet));
  const tooQuiet = detect(speechLike({ gainDb: -30 })); assert.equal(tooQuiet.hasSpeech, false, fmt(tooQuiet));
});

test("前後の無音が無い音声らしい信号でも声あり", () => {
  const a = detect(speechLike({ leadSec: 0, tailSec: 0 })); assert.ok(a.hasSpeech, fmt(a));
  const b = detect(speechLike({ leadSec: 0, tailSec: 0, gainDb: -20 })); assert.ok(b.hasSpeech, fmt(b));
});

test("クリック音12回は合計では長いが、続く長さが足りず声なし", () => {
  const d = detect(clicks());
  assert.equal(d.hasSpeech, false, fmt(d));
  assert.ok(d.longestRunSec < 0.12 && d.voicedSec >= 0.3, fmt(d));
});

test("しきい値の定数", () => { assert.equal(SPEECH_DETECTION.absoluteMinDbfs, -45); });

// ---- Workers 化で足した試験（Buffer でない入力・画面とサーバーの判定の一致）----
test("Buffer でない Uint8Array（byteOffset が奇数の部分配列）と ArrayBuffer でも読める", () => {
  const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 7) * 0.4);
  const wav = new Uint8Array(encodeWavPcm16(samples, 16000));
  const padded = new Uint8Array(wav.length + 3);
  padded.set(wav, 3); // 先頭に3バイトの余白：部分配列の byteOffset は奇数
  const sub = padded.subarray(3);
  assert.equal(sub.byteOffset % 2, 1);
  const fromSub = parseWav(sub);
  const fromBuffer = parseWav(wav.buffer.slice(0));
  const fromBuf = parseWav(Buffer.from(wav));
  assert.equal(fromSub.frameCount, 1600);
  assert.deepEqual([...fromSub.samples], [...fromBuf.samples]);
  assert.deepEqual([...fromBuffer.samples], [...fromBuf.samples]);
  assert.equal(inspectSpeechWav(sub).durationSec, 0.1);
  assert.equal(inspectSpeechWav(wav.buffer.slice(0)).sampleRate, 16000);
});

test("画面（Uint8Array）とサーバー（base64 → base64ToBytes）で、同じ WAV の声の判定が一致する", async () => {
  const { base64ToBytes } = await import("../src/server/bytes");
  for (const samples of [speechLike(), silence(2.2), noise(3, 120, 7), concat(silence(0.5), speechLike({ syllables: 1 }))]) {
    const bytes = new Uint8Array(encodeWavPcm16(samples, 16000));
    const onScreen = inspectSpeechWav(bytes);
    const onServer = inspectSpeechWav(base64ToBytes(Buffer.from(bytes).toString("base64")));
    assert.deepEqual(onScreen.detection, onServer.detection);
    assert.equal(onScreen.durationSec, onServer.durationSec);
  }
});
