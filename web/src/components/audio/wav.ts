/**
 * Client-side helpers for the recorder. The browser records in whatever codec
 * it supports (Opus/WebM, AAC/MP4…); we decode it, trim it, resample to 24 kHz
 * mono and encode a plain 16-bit WAV — a format the server can fully decode,
 * validate and normalise without native dependencies.
 */
export const TARGET_RATE = 24000;

export async function decodeToMono(blob: Blob): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const pcm = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) pcm[i]! += d[i]! / buf.numberOfChannels;
    }
    return { pcm, sampleRate: buf.sampleRate };
  } finally {
    void ctx.close();
  }
}

export async function resample(pcm: Float32Array, from: number, to = TARGET_RATE): Promise<Float32Array> {
  if (from === to) return pcm;
  const length = Math.max(1, Math.ceil((pcm.length * to) / from));
  const off = new OfflineAudioContext(1, length, to);
  const b = off.createBuffer(1, pcm.length, from);
  b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = b;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function peaksOf(pcm: Float32Array, bins = 96): number[] {
  const per = Math.max(1, Math.floor(pcm.length / bins));
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    let m = 0;
    for (let i = b * per; i < Math.min(pcm.length, (b + 1) * per); i++) m = Math.max(m, Math.abs(pcm[i]!));
    out.push(m);
  }
  const max = Math.max(...out, 1e-6);
  return out.map((x) => x / max);
}

export function peakAmplitude(pcm: Float32Array) {
  let m = 0;
  for (let i = 0; i < pcm.length; i++) m = Math.max(m, Math.abs(pcm[i]!));
  return m;
}
