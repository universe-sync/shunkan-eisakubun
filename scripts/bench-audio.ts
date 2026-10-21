// 録音 1 回分の処理にかかる CPU 時間の目安を測る（npm run bench:audio）。外へは通信しない。npm test には入れない。
// 注意：Workers の中では Date.now()・performance.now() は計算の間は進まない（I/O のときだけ進む）ので、Worker や DO の中に時間を測るログを入れても意味がない。
// 本番の値は Cloudflare のダッシュボード（Workers のメトリクスの CPU 時間、DO のメトリクス）で見る。Mac の値の 2 倍を目安の余裕とする。
import { inspectSpeechWav } from "../src/shared/audio.js";
import { base64ToBytes } from "../src/server/bytes";
import { gatePassword } from "../src/server/gate/policy";
import { issueToken, resolveCookieSecret, verifyToken } from "../src/server/gate/token";
import { concat, noise, speechLike, toWav } from "../tests/helpers/wav-fixtures";

type Stats = { cpuMedian: number; cpuMax: number; wallMedian: number; wallMax: number };
const WARMUP = 5;
const RUNS = 30;

function measure(work: () => unknown): Stats {
  for (let i = 0; i < WARMUP; i += 1) work();
  const cpu: number[] = [];
  const wall: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const usage = process.cpuUsage();
    const t = performance.now();
    work();
    wall.push(performance.now() - t);
    const used = process.cpuUsage(usage);
    cpu.push((used.user + used.system) / 1000);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
  return { cpuMedian: median(cpu), cpuMax: Math.max(...cpu), wallMedian: median(wall), wallMax: Math.max(...wall) };
}

/** 声に近い信号のあと、残りを小さな雑音で埋めて指定の秒数にした WAV */
function wavOfSeconds(sec: number): Uint8Array {
  const voice = speechLike();
  const rest = Math.max(0, sec - voice.length / 16000);
  return new Uint8Array(toWav(concat(voice, noise(rest, 15)).subarray(0, Math.round(sec * 16000))));
}

const f = (ms: number) => ms.toFixed(2).padStart(8);
const rows: string[] = [];
console.log("録音の長さごとの処理時間（ms）。cpu＝process.cpuUsage の差（user+system）、wall＝経過時間。中央値/最大（5回ならしてから30回）\n");
console.log("A〜D は DO の中（1 リクエスト 30 秒の枠）。E は Worker の中（1 リクエスト 10ms の枠）の門の確かめ（cookie の署名鍵を導く＋検証 1 回）。");
console.log("段階".padEnd(34), "長さ", " cpu中央値", "   cpu最大", " wall中央値", "  wall最大");
for (const sec of [60, 30, 10]) {
  const wav = wavOfSeconds(sec);
  const b64 = Buffer.from(wav).toString("base64");
  const bodyText = JSON.stringify({ sessionId: "00000000-0000-4000-8000-000000000000", questionId: "q001", mimeType: "audio/wav", audioBase64: b64, segmentEnd: "timeout" });
  const bytes = base64ToBytes(b64);
  const stages: [string, () => unknown][] = [
    ["A 本文の JSON.parse", () => JSON.parse(bodyText)],
    ["B base64ToBytes", () => base64ToBytes(b64)],
    ["C inspectSpeechWav", () => inspectSpeechWav(bytes)],
    ["D Gemini への本文の JSON.stringify", () => JSON.stringify({ model: "gemini-3.5-transcribe", input: [{ type: "audio", data: b64, mime_type: "audio/wav" }], generation_config: { transcription_config: { language_codes: ["en-US"], mode: { type: "verbatim" } } }, store: false })],
  ];
  let sumCpu = 0; let sumMax = 0;
  for (const [name, work] of stages) {
    const s = measure(work);
    sumCpu += s.cpuMedian; sumMax += s.cpuMax;
    rows.push(`${name.padEnd(34)} ${String(sec).padStart(3)}秒 ${f(s.cpuMedian)} ${f(s.cpuMax)} ${f(s.wallMedian)} ${f(s.wallMax)}`);
  }
  rows.push(`${"A+B+C+D の合計（DO の枠 30,000ms）".padEnd(34)} ${String(sec).padStart(3)}秒 ${f(sumCpu)} ${f(sumMax)}`);
  rows.push("");
}
console.log(rows.join("\n"));

// E：Worker の門。COOKIE_SECRET が無いときの最悪の場合（合言葉から鍵を導く）を測る
async function measureAsync(work: () => Promise<unknown>): Promise<Stats> {
  for (let i = 0; i < WARMUP; i += 1) await work();
  const cpu: number[] = [];
  const wall: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const usage = process.cpuUsage();
    const t = performance.now();
    await work();
    wall.push(performance.now() - t);
    const used = process.cpuUsage(usage);
    cpu.push((used.user + used.system) / 1000);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
  return { cpuMedian: median(cpu), cpuMax: Math.max(...cpu), wallMedian: median(wall), wallMax: Math.max(...wall) };
}
const env = { GATE_PASSWORD: "bench-only-password-0123456789" };
const token = await issueToken(await resolveCookieSecret(env), gatePassword(env), Date.now());
const gate = await measureAsync(async () => verifyToken(await resolveCookieSecret(env), gatePassword(env), token, Date.now()));
console.log(`\n${"E Worker の門（resolveCookieSecret＋verifyToken）".padEnd(34)}       ${f(gate.cpuMedian)} ${f(gate.cpuMax)} ${f(gate.wallMedian)} ${f(gate.wallMax)}   （Worker の枠 10ms。判断は cpu 中央値で）`);
