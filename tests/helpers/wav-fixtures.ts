// テスト用の WAV を作る補助。実際の音声ファイルは使わず、すべて計算で作る。
import { encodeWavPcm16 } from "../../src/client/lib/wav.js";

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
export const silence = (sec, sampleRate = 16000) => new Float32Array(Math.round(sec * sampleRate));
export function noise(sec, sigmaInt16, seed = 1, sampleRate = 16000) {
  const random = seededRandom(seed);
  const out = new Float32Array(Math.round(sec * sampleRate));
  for (let i = 0; i < out.length; i += 1) out[i] = gaussian(random) * sigmaInt16 / 32768;
  return out;
}
// 声に近い信号：基本周波数が少し揺れる6音節（倍音つき）。一定の部分は約 -18 dBFS。
export function speechLike({ gainDb = 0, leadSec = 0.5, tailSec = 0.8, syllables = 6, syllableSec = 0.18, gapSec = 0.07, amplitude = 0.15, f0 = 140, backgroundSigma = 15, seed = 1 } = {}, sampleRate = 16000) {
  const total = leadSec + syllables * (syllableSec + gapSec) + tailSec;
  const out = noise(total, backgroundSigma, seed, sampleRate);
  const gain = amplitude * 10 ** (gainDb / 20);
  const harmonics = [1, 0.5, 0.33, 0.25];
  const ramp = Math.round(0.02 * sampleRate);
  for (let k = 0; k < syllables; k += 1) {
    const start = Math.round((leadSec + k * (syllableSec + gapSec)) * sampleRate);
    const length = Math.round(syllableSec * sampleRate);
    const f = f0 * (1 + 0.05 * Math.sin(k));
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.min(1, i / ramp, (length - 1 - i) / ramp);
      let value = 0;
      harmonics.forEach((h, n) => { value += h * Math.sin(2 * Math.PI * f * (n + 1) * i / sampleRate); });
      out[start + i] += gain * envelope * value;
    }
  }
  return out;
}
export function clicks({ count = 12, startSec = 0.3, everySec = 0.25, amplitude = 0.5, backgroundSigma = 15, seed = 3 } = {}, sampleRate = 16000) {
  const out = noise(startSec + count * everySec + 0.5, backgroundSigma, seed, sampleRate);
  const length = Math.round(0.015 * sampleRate);
  for (let c = 0; c < count; c += 1) {
    const start = Math.round((startSec + c * everySec) * sampleRate);
    for (let i = 0; i < length; i += 1) out[start + i] += amplitude * Math.exp(-i / (0.002 * 16000)) * (i % 2 ? 1 : -1);
  }
  return out;
}
export function concat(...arrays) {
  const out = new Float32Array(arrays.reduce((total, a) => total + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
export const toWav = (samples, sampleRate = 16000) => Buffer.from(encodeWavPcm16(samples, sampleRate));

function chunk(id, body) {
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii"); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
// 手で組み立てる WAV。壊れたヘッダーや特殊な形式の試験用。
export function buildWav({ formatTag = 1, channels = 1, sampleRate = 16000, bitsPerSample = 16, fmtSize = 16, data = Buffer.alloc(0), before = [] as [string, Buffer][], omitFmt = false, omitData = false, dataFirst = false, declaredDataSize = undefined as number | undefined, riff = "RIFF", wave = "WAVE" } = {}) {
  const fmtBody = Buffer.alloc(Math.max(fmtSize, 0));
  if (fmtSize >= 16) {
    fmtBody.writeUInt16LE(formatTag, 0); fmtBody.writeUInt16LE(channels, 2); fmtBody.writeUInt32LE(sampleRate, 4);
    fmtBody.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 8); fmtBody.writeUInt16LE(channels * bitsPerSample / 8, 12); fmtBody.writeUInt16LE(bitsPerSample, 14);
  }
  const dataChunk = chunk("data", data);
  if (declaredDataSize !== undefined) dataChunk.writeUInt32LE(declaredDataSize, 4);
  const parts = [...before.map(([id, body]) => chunk(id, body))];
  if (dataFirst && !omitData) parts.push(dataChunk);
  if (!omitFmt) parts.push(chunk("fmt ", fmtBody));
  if (!dataFirst && !omitData) parts.push(dataChunk);
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write(riff, 0, "ascii"); header.writeUInt32LE(4 + body.length, 4); header.write(wave, 8, "ascii");
  return Buffer.concat([header, body]);
}
export const toBase64 = (buffer) => Buffer.from(buffer).toString("base64");
