// 録音を 16kHz・モノラル・16bit の WAV にするための純粋な関数。ブラウザでもテストでも使う。
export const TARGET_SAMPLE_RATE = 16000;

// 複数チャンネルを平均してモノラルにする。0本なら空、1本なら写し、2本以上なら最短の長さで平均する。
export function mixToMono(channels) {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const length = Math.min(...channels.map((channel) => channel.length));
  const mixed = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    mixed[i] = sum / channels.length;
  }
  return mixed;
}

// -1〜1 の標本を、44バイトのヘッダー付きの PCM16 WAV（ArrayBuffer）にする。
export function encodeWavPcm16(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Number.isNaN(samples[i]) ? 0 : Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return buffer;
}
