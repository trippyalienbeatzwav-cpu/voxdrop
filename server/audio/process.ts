import path from 'node:path';
import { AppError, Errors } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { decodeWav, encodeWav16, isWav, parseWav, waveformFromPcm, WavError } from './wav.js';
import { isMp3, Mp3Error, parseMp3, rebuildMp3, waveformFromGains } from './mp3.js';

export const ALLOWED_EXTENSIONS: Record<string, 'mp3' | 'wav'> = { '.mp3': 'mp3', '.wav': 'wav', '.wave': 'wav' };
export const ALLOWED_MIME: Record<string, 'mp3' | 'wav'> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/x-mpeg-3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
};

export const MIN_DURATION_MS = 300;
/** Peak normalisation target (-1 dBFS) and the maximum boost we will apply (+12 dB). */
const TARGET_PEAK = 0.891;
const MAX_GAIN = 3.981;
const SILENCE_PEAK = 0.002;

export interface ProcessInput {
  buffer: Buffer;
  filename: string;
  declaredMime: string;
  maxBytes: number;
  maxSeconds: number;
}

export interface ProcessedAudio {
  container: 'mp3' | 'wav';
  mime: 'audio/mpeg' | 'audio/wav';
  output: Buffer;
  durationMs: number;
  sampleRate: number;
  channels: number;
  waveform: number[];
  gainDb: number | null;
  sha256: string;
  steps: string[];
}

/**
 * Server-side audio validation + processing pipeline. Never trusts the client:
 *  1. size limit           4. full structural parse (every frame / chunk)
 *  2. extension allowlist  5. duration limits (min and streamer max)
 *  3. MIME allowlist +     6. silence check (empty recordings)
 *     magic-byte sniff,    7. re-encode: WAV → normalised canonical PCM16,
 *     all three must agree    MP3 → audio frames only (tags/payloads stripped)
 */
export function processAudio(input: ProcessInput): ProcessedAudio {
  const steps: string[] = [];
  const { buffer } = input;
  if (buffer.length === 0) throw new AppError(422, 'EMPTY_AUDIO', 'The file is empty');
  if (buffer.length > input.maxBytes) throw Errors.fileTooLarge(input.maxBytes);
  steps.push('size');

  const ext = path.extname(input.filename || '').toLowerCase();
  const byExt = ALLOWED_EXTENSIONS[ext];
  if (!byExt) throw Errors.unsupportedMedia('Only .mp3 and .wav files are accepted');
  const byMime = ALLOWED_MIME[(input.declaredMime || '').toLowerCase().split(';')[0]!.trim()];
  if (!byMime) throw Errors.unsupportedMedia('Unsupported audio MIME type');
  const sniffed = isWav(buffer) ? 'wav' : isMp3(buffer) ? 'mp3' : null;
  if (!sniffed) throw Errors.unsupportedMedia('File contents are not valid MP3 or WAV audio');
  if (sniffed !== byExt || sniffed !== byMime) throw Errors.unsupportedMedia('File extension, MIME type and contents do not match');
  steps.push('type');

  try {
    if (sniffed === 'wav') {
      const info = parseWav(buffer);
      checkDuration(info.durationMs, input.maxSeconds);
      steps.push('parse', 'duration');
      const pcm = decodeWav(buffer, info);
      let peak = 0;
      for (const ch of pcm) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
      if (peak < SILENCE_PEAK) throw new AppError(422, 'EMPTY_AUDIO', 'The recording is silent');
      let gain = 1;
      if (peak < TARGET_PEAK) gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
      if (gain !== 1) for (const ch of pcm) for (let i = 0; i < ch.length; i++) ch[i]! *= gain;
      steps.push('normalize');
      const output = encodeWav16(pcm, info.sampleRate);
      return {
        container: 'wav',
        mime: 'audio/wav',
        output,
        durationMs: info.durationMs,
        sampleRate: info.sampleRate,
        channels: info.channels,
        waveform: waveformFromPcm(pcm),
        gainDb: Math.round(20 * Math.log10(gain) * 10) / 10,
        sha256: sha256(output),
        steps: [...steps, 'reencode', 'waveform'],
      };
    }

    const info = parseMp3(buffer);
    checkDuration(info.durationMs, input.maxSeconds);
    steps.push('parse', 'duration');
    if (info.gains.every((g) => g === 0)) throw new AppError(422, 'EMPTY_AUDIO', 'The audio is silent');
    const output = rebuildMp3(buffer, info);
    return {
      container: 'mp3',
      mime: 'audio/mpeg',
      output,
      durationMs: info.durationMs,
      sampleRate: info.sampleRate,
      channels: info.channels,
      waveform: waveformFromGains(info.gains),
      // MP3 loudness normalisation needs a decoder/encoder (e.g. an ffmpeg
      // worker); frames are passed through unmodified.
      gainDb: null,
      sha256: sha256(output),
      steps: [...steps, 'strip-tags', 'waveform'],
    };
  } catch (err) {
    if (err instanceof WavError || err instanceof Mp3Error) throw new AppError(422, 'INVALID_AUDIO', `Invalid audio file: ${err.message}`);
    throw err;
  }
}

function checkDuration(ms: number, maxSeconds: number) {
  if (ms < MIN_DURATION_MS) throw new AppError(422, 'AUDIO_TOO_SHORT', 'Audio must be at least 0.3 seconds long');
  if (ms > maxSeconds * 1000 + 250) throw Errors.audioTooLong(ms, maxSeconds);
}
