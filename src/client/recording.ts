import { TARGET_SAMPLE_RATE, encodeWavPcm16, mixToMono } from "./lib/wav.js";

export function canConvertRecording(): boolean {
  return typeof window !== "undefined" && typeof window.OfflineAudioContext === "function";
}

// MediaRecorder の録音（webm/opus・mp4/aac など）を 16kHz・モノラル・16bit の WAV にする。
// Web Audio の仕様では、decodeAudioData はデコードした音声を「その AudioContext の標本化周波数」に再標本化する。
// そのため 16kHz の OfflineAudioContext でデコードすれば、ブラウザの再標本化器で 16kHz になる。
export async function convertRecordingToWav(recording: Blob): Promise<{ blob: Blob; durationSec: number; bytes: Uint8Array }> {
  if (!canConvertRecording()) throw new Error("unsupported");
  const decoder = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
  let mono: Float32Array;
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) {
    mono = mixToMono(Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index)));
  } else { // 念のための予備：描画で 16kHz・1チャンネルにする（ダウンミックスもされる）
    const renderer = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)), TARGET_SAMPLE_RATE);
    const source = renderer.createBufferSource();
    source.buffer = decoded; source.connect(renderer.destination); source.start();
    mono = (await renderer.startRendering()).getChannelData(0).slice();
  }
  const encoded = encodeWavPcm16(mono, TARGET_SAMPLE_RATE);
  // bytes は、ブラウザで声の有無を判定する（shared/audio.js）ために同じ WAV を Uint8Array で渡す
  return { blob: new Blob([encoded], { type: "audio/wav" }), durationSec: mono.length / TARGET_SAMPLE_RATE, bytes: new Uint8Array(encoded) };
}
