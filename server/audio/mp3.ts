/**
 * MPEG-1/2/2.5 Layer III frame scanner.
 *
 * Walks every frame of the file (so VBR durations are exact), verifies frame
 * sync consistency, measures junk between frames, extracts each frame's
 * `global_gain` side-info field as a loudness proxy for waveform previews, and
 * can re-emit the file as ONLY its audio frames — stripping ID3/APE tags,
 * embedded images and any appended payload (polyglot files).
 */

export class Mp3Error extends Error {}

export interface Mp3Frame {
  offset: number;
  length: number;
}

export interface Mp3Info {
  frames: Mp3Frame[];
  durationMs: number;
  sampleRate: number;
  channels: number;
  version: 1 | 2 | 2.5;
  avgBitrateKbps: number;
  gains: number[];
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

interface Header {
  version: 1 | 2 | 2.5;
  crc: boolean;
  bitrate: number;
  sampleRate: number;
  padding: number;
  channels: number;
  length: number;
  samples: number;
}

export function readHeader(buf: Buffer, off: number): Header | null {
  if (off + 4 > buf.length) return null;
  const b0 = buf[off]!, b1 = buf[off + 1]!, b2 = buf[off + 2]!, b3 = buf[off + 3]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const vBits = (b1 >> 3) & 3;
  if (vBits === 1) return null; // reserved
  const layer = (b1 >> 1) & 3;
  if (layer !== 1) return null; // Layer III only
  const version: 1 | 2 | 2.5 = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null; // free-format / invalid
  const bitrate = (version === 1 ? BITRATES_V1 : BITRATES_V2)[brIdx]!;
  const sampleRate = RATES[String(version)]![srIdx]!;
  const padding = (b2 >> 1) & 1;
  const channels = ((b3 >> 6) & 3) === 3 ? 1 : 2;
  const samples = version === 1 ? 1152 : 576;
  const length = Math.floor(((version === 1 ? 144000 : 72000) * bitrate) / sampleRate) + padding;
  return { version, crc: (b1 & 1) === 0, bitrate, sampleRate, padding, channels, length, samples };
}

function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const s = [buf[6]!, buf[7]!, buf[8]!, buf[9]!];
  if (s.some((x) => x & 0x80)) throw new Mp3Error('Corrupt ID3 tag');
  const footer = (buf[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + ((s[0]! << 21) | (s[1]! << 14) | (s[2]! << 7) | s[3]!) + footer;
}

/** Reads `global_gain` of granule 0 / channel 0 (0 when the granule is empty). */
function frameGain(buf: Buffer, off: number, h: Header): number {
  let bit = (off + 4 + (h.crc ? 2 : 0)) * 8;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((buf[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return v;
  };
  if (h.version === 1) read(9 + (h.channels === 1 ? 5 : 3) + 4 * h.channels);
  else read(8 + (h.channels === 1 ? 1 : 2));
  const part23 = read(12);
  read(9);
  const gain = read(8);
  return part23 === 0 ? 0 : gain;
}

export function isMp3(buf: Buffer): boolean {
  try {
    const start = id3v2Size(buf);
    const h = readHeader(buf, start);
    return !!h && !!readHeader(buf, start + h.length);
  } catch {
    return false;
  }
}

export function parseMp3(buf: Buffer): Mp3Info {
  let off = id3v2Size(buf);
  if (off >= buf.length) throw new Mp3Error('No audio after ID3 tag');
  // Tolerate a little encoder padding before the first frame, but require two
  // consecutive valid headers so random bytes cannot pose as MP3.
  const limit = Math.min(buf.length, off + 4096);
  let first: Header | null = null;
  for (; off < limit; off++) {
    const h = readHeader(buf, off);
    if (h && readHeader(buf, off + h.length)) {
      first = h;
      break;
    }
  }
  if (!first) throw new Mp3Error('No MPEG Layer III frame at start of audio');

  const frames: Mp3Frame[] = [];
  const gains: number[] = [];
  let junk = 0;
  let samples = 0;
  let bits = 0;
  while (off < buf.length) {
    const h = readHeader(buf, off);
    if (h && h.version === first.version && h.sampleRate === first.sampleRate && off + h.length <= buf.length) {
      frames.push({ offset: off, length: h.length });
      gains.push(frameGain(buf, off, h));
      samples += h.samples;
      bits += h.bitrate;
      off += h.length;
      continue;
    }
    const rest = buf.length - off;
    if (rest === 128 && buf.toString('latin1', off, off + 3) === 'TAG') break; // ID3v1
    if (buf.toString('latin1', off, off + 8) === 'APETAGEX') break;
    if (h && off + h.length > buf.length) break; // truncated final frame: drop it
    junk++;
    off++;
    if (junk > 8192 || junk > buf.length * 0.05) throw new Mp3Error('File contains non-audio data between frames');
  }
  if (frames.length < 8) throw new Mp3Error('Too few audio frames');
  return {
    frames,
    durationMs: Math.round((samples / first.sampleRate) * 1000),
    sampleRate: first.sampleRate,
    channels: first.channels,
    version: first.version,
    avgBitrateKbps: Math.round(bits / frames.length),
    gains,
  };
}

/** Rebuilds the file from validated frames only (drops tags / trailing data). */
export function rebuildMp3(buf: Buffer, info: Mp3Info): Buffer {
  return Buffer.concat(info.frames.map((f) => buf.subarray(f.offset, f.offset + f.length)));
}

/** Loudness-proxy waveform from per-frame global_gain (amplitude ≈ 2^(gain/4)). */
export function waveformFromGains(gains: number[], bins = 64): number[] {
  if (!gains.length) return [];
  const amps = gains.map((g) => (g === 0 ? 0 : Math.pow(2, (g - 210) / 4)));
  const per = Math.max(1, Math.floor(amps.length / bins));
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    const slice = amps.slice(b * per, b === bins - 1 ? amps.length : (b + 1) * per);
    out.push(slice.length ? Math.max(...slice) : 0);
  }
  const max = Math.max(...out, 1e-9);
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}
