import { describe, expect, it } from 'vitest';
import { processAudio } from '../../server/audio/process.js';
import { decodeWav, parseWav } from '../../server/audio/wav.js';
import { isMp3, parseMp3 } from '../../server/audio/mp3.js';
import { fakeMp3, silence, tone } from '../helpers/audio.js';

const base = { maxBytes: 8 * 1024 * 1024, maxSeconds: 60 };

describe('WAV validation & processing', () => {
  it('parses duration and re-encodes as canonical PCM16 with peak normalisation', () => {
    const wav = tone(2, 440, 0.25);
    const r = processAudio({ ...base, buffer: wav, filename: 'hi.wav', declaredMime: 'audio/wav' });
    expect(r.container).toBe('wav');
    expect(r.durationMs).toBe(2000);
    expect(r.gainDb).toBeGreaterThan(5); // 0.25 → ~0.89 peak ≈ +11 dB
    const info = parseWav(r.output);
    expect(info.bitsPerSample).toBe(16);
    const pcm = decodeWav(r.output, info);
    const peak = Math.max(...Array.from(pcm[0]!).map(Math.abs));
    expect(peak).toBeGreaterThan(0.85);
    expect(peak).toBeLessThanOrEqual(0.9);
    expect(r.waveform).toHaveLength(64);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects audio longer than the channel limit', () => {
    expect(() => processAudio({ ...base, maxSeconds: 5, buffer: tone(6), filename: 'long.wav', declaredMime: 'audio/wav' })).toThrow(
      expect.objectContaining({ code: 'AUDIO_TOO_LONG' }),
    );
  });

  it('rejects files over the size limit before parsing', () => {
    expect(() => processAudio({ ...base, maxBytes: 1000, buffer: tone(1), filename: 'a.wav', declaredMime: 'audio/wav' })).toThrow(
      expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    );
  });

  it('rejects silent recordings (prevents sending empty audio)', () => {
    expect(() => processAudio({ ...base, buffer: silence(2), filename: 'quiet.wav', declaredMime: 'audio/wav' })).toThrow(
      expect.objectContaining({ code: 'EMPTY_AUDIO' }),
    );
  });

  it('rejects too-short audio', () => {
    expect(() => processAudio({ ...base, buffer: tone(0.1), filename: 'blip.wav', declaredMime: 'audio/wav' })).toThrow(
      expect.objectContaining({ code: 'AUDIO_TOO_SHORT' }),
    );
  });

  it('strips non-audio RIFF chunks (metadata cannot survive re-encoding)', () => {
    const wav = tone(1);
    // Insert a LIST chunk with a payload before the data chunk
    const payload = Buffer.from('LIST\x10\x00\x00\x00<script>xx</sc>!', 'latin1');
    const withList = Buffer.concat([wav.subarray(0, 36), payload, wav.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    const r = processAudio({ ...base, buffer: withList, filename: 'meta.wav', declaredMime: 'audio/wav' });
    expect(r.output.includes(Buffer.from('<script>'))).toBe(false);
  });
});

describe('type detection — extension, MIME and magic bytes must all agree', () => {
  it('rejects a text file renamed to .mp3', () => {
    expect(() => processAudio({ ...base, buffer: Buffer.from('<html><script>alert(1)</script></html>'.repeat(50)), filename: 'evil.mp3', declaredMime: 'audio/mpeg' })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('rejects a WAV uploaded with an .mp3 extension', () => {
    expect(() => processAudio({ ...base, buffer: tone(1), filename: 'x.mp3', declaredMime: 'audio/mpeg' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA' }));
  });

  it('rejects a mismatched MIME type', () => {
    expect(() => processAudio({ ...base, buffer: tone(1), filename: 'x.wav', declaredMime: 'audio/mpeg' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA' }));
  });

  it('rejects disallowed extensions', () => {
    expect(() => processAudio({ ...base, buffer: tone(1), filename: 'x.exe', declaredMime: 'audio/wav' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA' }));
  });
});

describe('MP3 frame scanning', () => {
  it('computes duration from every frame and extracts a waveform', () => {
    const mp3 = fakeMp3(200); // 200 * 1152 / 44100 ≈ 5.22s
    expect(isMp3(mp3)).toBe(true);
    const info = parseMp3(mp3);
    expect(info.frames).toHaveLength(200);
    expect(info.durationMs).toBe(Math.round((200 * 1152 * 1000) / 44100));
    const r = processAudio({ ...base, buffer: mp3, filename: 'clip.mp3', declaredMime: 'audio/mpeg' });
    expect(r.container).toBe('mp3');
    expect(r.waveform.length).toBe(64);
  });

  it('strips ID3 tags and small trailing payloads from the stored file', () => {
    const mp3 = fakeMp3(100, 180, { id3: true, trailing: Buffer.from('<?php echo 1; ?>') });
    const r = processAudio({ ...base, buffer: mp3, filename: 'tagged.mp3', declaredMime: 'audio/mpeg' });
    expect(r.output.length).toBe(100 * 417);
    expect(r.output.includes(Buffer.from('hidden payload'))).toBe(false);
    expect(r.output.includes(Buffer.from('<?php'))).toBe(false);
  });

  it('rejects files with large non-audio regions (polyglots)', () => {
    const mp3 = fakeMp3(40, 180, { trailing: Buffer.alloc(9000, 0x41) });
    expect(() => processAudio({ ...base, buffer: mp3, filename: 'poly.mp3', declaredMime: 'audio/mpeg' })).toThrow(expect.objectContaining({ code: 'INVALID_AUDIO' }));
  });

  it('rejects silent MP3 (all frames empty)', () => {
    expect(() => processAudio({ ...base, buffer: fakeMp3(100, 0), filename: 's.mp3', declaredMime: 'audio/mpeg' })).toThrow(expect.objectContaining({ code: 'EMPTY_AUDIO' }));
  });

  it('enforces the duration limit for MP3', () => {
    expect(() => processAudio({ ...base, maxSeconds: 3, buffer: fakeMp3(200), filename: 'l.mp3', declaredMime: 'audio/mpeg' })).toThrow(expect.objectContaining({ code: 'AUDIO_TOO_LONG' }));
  });
});
