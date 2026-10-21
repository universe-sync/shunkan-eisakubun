// 瞬間英作文の録音（WAV）を調べる純粋な関数。入出力も保存もしない。画面（ブラウザ）とサーバー（DO）の両方が読む。
// 声の有無はモデルではなく音量で判定する（モデルは無音や雑音からでも英文を作ってしまうため）。
import { NO_LIMIT_CAP_SECONDS } from "./instant-rules.js";

export const SPEECH_WAV_FORMAT = Object.freeze({ sampleRate: 16000, channels: 1, bitsPerSample: 16, maxDurationSec: NO_LIMIT_CAP_SECONDS + 5 }); // 1問の最長（制限なしの上限60秒）＋余裕5秒
export const SPEECH_DETECTION = Object.freeze({
  frameMs: 30,               // 区間の長さ
  absoluteMinDbfs: -45,      // 区間の RMS の絶対しきい値
  relativeMinDb: 10,         // 雑音の底より何 dB 大きければ声とみなすか
  noiseFloorPercentile: 0.1, // 雑音の底 = 区間の音量の下位10%
  digitalSilenceDbfs: -90,   // これ未満の区間は完全な無音とみなし、雑音の底の計算から除く
  minVoicedSec: 0.3,         // 声の区間の合計
  minLongestRunSec: 0.12     // 声の区間が続く最長の長さ
});

const UNREADABLE = "録音データ（WAV）を読み取れませんでした。もう一度録音してください。";
const WRONG_FORMAT = "録音データの形式が違います（16kHz・モノラル・16bitのWAVが必要です）。画面を再読み込みしてから、もう一度録音してください。";

export class WavFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WavFormatError";
    this.code = code;
    this.status = 400;
  }
}

const fail = (code, message = UNREADABLE) => { throw new WavFormatError(code, message); };

// Uint8Array（Buffer も可）| ArrayBuffer → 形式と標本（モノラルの Int16Array）
export function parseWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from, to) => { let text = ""; for (let i = from; i < to && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]); return text; };
  if (bytes.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") fail("not_wav");
  let fmt = null;
  let data = null;
  let offset = 12; // RIFF ヘッダーの全体長は信用せず、bytes.length までを読む
  while (offset + 8 <= bytes.length && !(fmt && data)) {
    const id = ascii(offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (id === "fmt ") {
      if (size < 16 || end > bytes.length) fail("bad_fmt");
      if (!fmt) {
        let audioFormat = view.getUint16(start, true);
        if (audioFormat === 0xfffe && size >= 40) audioFormat = view.getUint16(start + 24, true);
        fmt = { audioFormat, channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), blockAlign: view.getUint16(start + 12, true), bitsPerSample: view.getUint16(start + 14, true) };
      }
    } else if (id === "data") {
      if (end > bytes.length) fail("truncated");
      if (!data) data = { start, size };
    } else if (end > bytes.length) {
      break; // 末尾の半端なチャンク
    }
    offset = end + (size & 1); // 奇数長の埋め草1バイト
  }
  if (!fmt) fail("missing_fmt");
  if (!data) fail("missing_data");
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) fail("unsupported_encoding", WRONG_FORMAT);
  if (fmt.channels < 1 || fmt.sampleRate < 1 || fmt.blockAlign !== fmt.channels * 2) fail("bad_fmt");
  const frameCount = Math.floor(data.size / fmt.blockAlign);
  if (frameCount === 0) fail("empty");
  // 位置が2の倍数とは限らないので、DataView で1つずつ読む（DataView は位置の制約が無い）
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c += 1) sum += view.getInt16(data.start + (i * fmt.channels + c) * 2, true);
    samples[i] = fmt.channels === 1 ? sum : Math.round(sum / fmt.channels);
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: 16, frameCount, durationSec: frameCount / fmt.sampleRate, samples };
}

// 重ならない区間ごとに、平均（直流分）を引いた RMS を dBFS で返す。最後の半端な区間は捨てる。
export function frameLevelsDbfs(samples, sampleRate, frameMs = 30) {
  const length = Math.round(sampleRate * frameMs / 1000);
  const count = Math.floor(samples.length / length);
  const levels = new Float64Array(count);
  for (let f = 0; f < count; f += 1) {
    const from = f * length;
    let mean = 0;
    for (let i = 0; i < length; i += 1) mean += samples[from + i];
    mean /= length;
    let square = 0;
    for (let i = 0; i < length; i += 1) { const v = samples[from + i] - mean; square += v * v; }
    const rms = Math.sqrt(square / length);
    levels[f] = rms === 0 ? -120 : Math.max(-120, 20 * Math.log10(rms / 32768));
  }
  return levels;
}

// 声のある区間が足りているかを返す。秒の比較は区間の数で行う（小数の誤差を避ける）。
export function detectSpeech(samples, sampleRate, options = {}) {
  const o = { ...SPEECH_DETECTION, ...options };
  const levels = frameLevelsDbfs(samples, sampleRate, o.frameMs);
  const frameSec = Math.round(sampleRate * o.frameMs / 1000) / sampleRate;
  const audible = [...levels].filter((level) => level > o.digitalSilenceDbfs).sort((a, b) => a - b);
  const noiseFloorDbfs = audible.length ? audible[Math.floor(o.noiseFloorPercentile * (audible.length - 1))] : -120;
  const thresholdDbfs = Math.max(o.absoluteMinDbfs, noiseFloorDbfs + o.relativeMinDb);
  let voiced = 0; let longest = 0; let run = 0; let peakFrameDbfs = -120;
  for (const level of levels) {
    if (level > peakFrameDbfs) peakFrameDbfs = level;
    if (level >= thresholdDbfs) { voiced += 1; run += 1; if (run > longest) longest = run; } else run = 0;
  }
  const needVoiced = Math.ceil(o.minVoicedSec / frameSec - 1e-9);
  const needRun = Math.ceil(o.minLongestRunSec / frameSec - 1e-9);
  return { hasSpeech: voiced >= needVoiced && longest >= needRun, voicedSec: voiced * frameSec, longestRunSec: longest * frameSec, noiseFloorDbfs, thresholdDbfs, peakFrameDbfs, frameCount: levels.length };
}

// parseWav ＋ 形式の条件（16kHz・モノラル・65秒以内）＋ detectSpeech
export function inspectSpeechWav(input) {
  const wav = parseWav(input);
  if (wav.sampleRate !== SPEECH_WAV_FORMAT.sampleRate || wav.channels !== SPEECH_WAV_FORMAT.channels) fail("unsupported_format", WRONG_FORMAT);
  if (wav.durationSec > SPEECH_WAV_FORMAT.maxDurationSec) fail("too_long", `録音が長すぎます。1問の録音は${NO_LIMIT_CAP_SECONDS}秒までです。`);
  return { sampleRate: wav.sampleRate, channels: wav.channels, durationSec: wav.durationSec, detection: detectSpeech(wav.samples, wav.sampleRate) };
}

const round = (value, digits) => Number(value.toFixed(digits));
// 応答に入れる丸めた数値。音声も文字も含まない。
export function audioSummary(inspected) {
  const d = inspected.detection;
  return { durationSec: round(inspected.durationSec, 2), voicedSec: round(d.voicedSec, 2), longestRunSec: round(d.longestRunSec, 2), peakFrameDbfs: round(d.peakFrameDbfs, 1), noiseFloorDbfs: round(d.noiseFloorDbfs, 1), thresholdDbfs: round(d.thresholdDbfs, 1) };
}
