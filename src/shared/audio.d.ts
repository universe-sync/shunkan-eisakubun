export const SPEECH_WAV_FORMAT: Readonly<{ sampleRate: 16000; channels: 1; bitsPerSample: 16; maxDurationSec: number }>;
export const SPEECH_DETECTION: Readonly<{ frameMs: number; absoluteMinDbfs: number; relativeMinDb: number; noiseFloorPercentile: number; digitalSilenceDbfs: number; minVoicedSec: number; minLongestRunSec: number }>;
export class WavFormatError extends Error { code: string; status: 400; constructor(code: string, message: string); }
export type ParsedWav = { sampleRate: number; channels: number; bitsPerSample: 16; frameCount: number; durationSec: number; samples: Int16Array };
export type SpeechDetection = { hasSpeech: boolean; voicedSec: number; longestRunSec: number; noiseFloorDbfs: number; thresholdDbfs: number; peakFrameDbfs: number; frameCount: number };
export type InspectedWav = { sampleRate: number; channels: number; durationSec: number; detection: SpeechDetection };
export type AudioSummary = { durationSec: number; voicedSec: number; longestRunSec: number; peakFrameDbfs: number; noiseFloorDbfs: number; thresholdDbfs: number };
export function parseWav(input: Uint8Array | ArrayBuffer): ParsedWav;
export function frameLevelsDbfs(samples: Int16Array, sampleRate: number, frameMs?: number): Float64Array;
export function detectSpeech(samples: Int16Array, sampleRate: number, options?: Partial<{ frameMs: number; absoluteMinDbfs: number; relativeMinDb: number; noiseFloorPercentile: number; digitalSilenceDbfs: number; minVoicedSec: number; minLongestRunSec: number }>): SpeechDetection;
export function inspectSpeechWav(input: Uint8Array | ArrayBuffer): InspectedWav;
export function audioSummary(inspected: InspectedWav): AudioSummary;
