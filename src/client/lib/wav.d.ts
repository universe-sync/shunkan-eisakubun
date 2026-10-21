export const TARGET_SAMPLE_RATE: 16000;
export function mixToMono(channels: readonly Float32Array[]): Float32Array;
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer;
