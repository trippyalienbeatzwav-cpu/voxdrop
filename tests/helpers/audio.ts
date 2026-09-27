import { encodeWav16 } from '../../server/audio/wav.js';

export function tone(seconds: number, freq = 440, amp = 0.5, sampleRate = 16000): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return encodeWav16([a], sampleRate);
}

export function silence(seconds: number, sampleRate = 16000): Buffer {
  return encodeWav16([new Float32Array(Math.floor(seconds * sampleRate))], sampleRate);
}

/**
 * Builds a structurally valid MPEG-1 Layer III stream (128 kbps, 44.1 kHz,
 * joint stereo) with a non-zero global_gain in each frame's side info. The
 * payload is pseudo-random — enough for container validation, not decoding.
 */
export function fakeMp3(frames: number, gain = 180, opts: { id3?: boolean; trailing?: Buffer } = {}): Buffer {
  const FRAME_LEN = 417; // floor(144000 * 128 / 44100)
  const out: Buffer[] = [];
  if (opts.id3) {
    const tag = Buffer.alloc(10 + 20);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 3;
    tag[9] = 20; // syncsafe size
    tag.write('TIT2 hidden payload', 10, 'latin1');
    out.push(tag);
  }
  let seed = 1;
  for (let f = 0; f < frames; f++) {
    const b = Buffer.alloc(FRAME_LEN);
    b[0] = 0xff;
    b[1] = 0xfb; // MPEG1, Layer III, no CRC
    b[2] = 0x90; // 128 kbps, 44.1 kHz, no padding
    b[3] = 0x64; // joint stereo
    // Side info bits: main_data_begin(9)=0, private(3)=0, scfsi(8)=0, part2_3_length(12)=300, big_values(9)=10, global_gain(8)
    const bits: Array<[number, number]> = [[0, 9], [0, 3], [0, 8], [300, 12], [10, 9], [gain, 8]];
    let bit = 4 * 8;
    for (const [v, n] of bits) {
      for (let i = n - 1; i >= 0; i--, bit++) if ((v >> i) & 1) b[bit >> 3]! |= 1 << (7 - (bit & 7));
    }
    for (let i = 12; i < FRAME_LEN; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      b[i] = seed & 0xff;
      if (b[i] === 0xff) b[i] = 0xfe; // avoid accidental sync words
    }
    out.push(b);
  }
  if (opts.trailing) out.push(opts.trailing);
  return Buffer.concat(out);
}
