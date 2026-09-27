/**
 * Strict RIFF/WAVE parser, PCM decoder and 16-bit PCM encoder.
 * Pure TypeScript — no native dependencies — so every upload can be fully
 * decoded, validated, normalized and re-encoded server-side.
 */

export interface WavInfo {
  audioFormat: 1 | 3; // 1 = integer PCM, 3 = IEEE float
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataOffset: number;
  dataLength: number;
  frames: number;
  durationMs: number;
}

export class WavError extends Error {}

const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function isWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

export function parseWav(buf: Buffer): WavInfo {
  if (!isWav(buf)) throw new WavError('Not a RIFF/WAVE file');
  let off = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength' | 'frames' | 'durationMs'> | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  let chunks = 0;

  while (off + 8 <= buf.length) {
    if (++chunks > 64) throw new WavError('Too many RIFF chunks');
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (!/^[\x20-\x7e]{4}$/.test(id)) throw new WavError('Corrupt chunk header');

    if (id === 'fmt ') {
      if (size < 16 || body + size > buf.length) throw new WavError('Invalid fmt chunk');
      let audioFormat = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && size >= 40) audioFormat = buf.readUInt16LE(body + 24); // SubFormat GUID's first 2 bytes
      if (audioFormat !== 1 && audioFormat !== 3) throw new WavError('Only PCM or IEEE-float WAV is supported');
      if (channels < 1 || channels > 2) throw new WavError('Only mono or stereo audio is supported');
      if (sampleRate < 8000 || sampleRate > 96000) throw new WavError('Unsupported sample rate');
      const okBits = audioFormat === 1 ? [8, 16, 24, 32].includes(bitsPerSample) : bitsPerSample === 32;
      if (!okBits) throw new WavError('Unsupported bit depth');
      if (blockAlign !== channels * (bitsPerSample / 8)) throw new WavError('Inconsistent block alignment');
      fmt = { audioFormat: audioFormat as 1 | 3, channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === 'data') {
      dataOffset = body;
      // Streaming writers sometimes emit 0 / 0xFFFFFFFF sizes; clamp to the real file.
      dataLength = Math.min(size === 0 || size === 0xffffffff ? buf.length - body : size, buf.length - body);
      break;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new WavError('Missing fmt chunk');
  if (dataOffset < 0) throw new WavError('Missing data chunk');
  const frames = Math.floor(dataLength / fmt.blockAlign);
  if (frames <= 0) throw new WavError('WAV contains no audio');
  return { ...fmt, dataOffset, dataLength: frames * fmt.blockAlign, frames, durationMs: Math.round((frames / fmt.sampleRate) * 1000) };
}

/** Decodes to one Float32Array per channel in [-1, 1]. */
export function decodeWav(buf: Buffer, info: WavInfo): Float32Array[] {
  const out = Array.from({ length: info.channels }, () => new Float32Array(info.frames));
  const bytes = info.bitsPerSample / 8;
  let p = info.dataOffset;
  for (let i = 0; i < info.frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      let v: number;
      if (info.audioFormat === 3) v = buf.readFloatLE(p);
      else if (bytes === 1) v = (buf[p]! - 128) / 128;
      else if (bytes === 2) v = buf.readInt16LE(p) / 32768;
      else if (bytes === 3) v = buf.readIntLE(p, 3) / 8388608;
      else v = buf.readInt32LE(p) / 2147483648;
      out[c]![i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      p += bytes;
    }
  }
  return out;
}

/** Encodes channel arrays as canonical 16-bit PCM WAV with no extra chunks. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Buffer {
  const nCh = channels.length;
  const frames = channels[0]!.length;
  const dataLen = frames * nCh * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nCh * 2, 28);
  buf.writeUInt16LE(nCh * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), p);
      p += 2;
    }
  }
  return buf;
}

/** Peak-amplitude waveform (0..1) with `bins` buckets, computed over all channels. */
export function waveformFromPcm(channels: Float32Array[], bins = 64): number[] {
  const frames = channels[0]!.length;
  const out: number[] = [];
  const per = Math.max(1, Math.floor(frames / bins));
  for (let b = 0; b < bins; b++) {
    let peak = 0;
    const start = b * per;
    const end = b === bins - 1 ? frames : Math.min(frames, start + per);
    for (const ch of channels) for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(ch[i]!));
    out.push(Math.round(peak * 1000) / 1000);
  }
  const max = Math.max(...out, 1e-6);
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}
