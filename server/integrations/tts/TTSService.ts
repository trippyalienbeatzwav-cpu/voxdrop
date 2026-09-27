import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeWav16 } from '../../audio/wav.js';
import { AppError } from '../../lib/errors.js';

export interface TtsVoice {
  id: string;
  name: string;
  locale: string;
  gender?: string;
}

export interface TtsRequest {
  /** Plain text only — already sanitised by lib/speech.ts. Never SSML. */
  text: string;
  voice: string;
  locale: string;
  /** 0.5 – 2.0, 1 = normal. */
  speed: number;
}

/**
 * Text-to-speech provider. Implementations MUST treat `text` as plain text
 * (no SSML/markup APIs) and return a WAV file.
 */
export interface TTSService {
  readonly name: 'mock' | 'sapi' | 'espeak' | 'google' | 'none';
  readonly available: boolean;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(req: TtsRequest): Promise<Buffer>;
}

export class TtsError extends AppError {
  constructor(message: string) {
    super(502, 'TTS_FAILED', message);
  }
}

/** Runs a binary with arguments (never through a shell) and returns stdout. */
function run(cmd: string, args: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, env: { ...process.env, ...opts.env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TtsError('Speech synthesis timed out'));
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new TtsError(`Speech engine unavailable: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new TtsError(`Speech engine exited with ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 200)}`));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8');
    else child.stdin.end();
  });
}

/**
 * Windows SAPI (System.Speech) via PowerShell — real speech on any Windows
 * machine, no credentials. The text and voice are passed through environment
 * variables, never interpolated into the script, and spoken with Speak()
 * (plain text), not SpeakSsml().
 */
export class SapiTtsService implements TTSService {
  readonly name = 'sapi' as const;
  readonly available = process.platform === 'win32';
  private voices: TtsVoice[] | null = null;

  async listVoices() {
    if (this.voices) return this.voices;
    const script =
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; locale = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } } | ConvertTo-Json -Compress';
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 });
    const parsed = JSON.parse(out.toString('utf8') || '[]') as TtsVoice | TtsVoice[];
    this.voices = Array.isArray(parsed) ? parsed : [parsed];
    return this.voices;
  }

  async synthesize(req: TtsRequest) {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-tts-'));
    const file = path.join(dir, 'out.wav');
    const rate = Math.max(-10, Math.min(10, Math.round((req.speed - 1) * 10)));
    const script =
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      'if ($env:VX_TTS_VOICE) { try { $s.SelectVoice($env:VX_TTS_VOICE) } catch {} }; ' +
      '$s.Rate = [int]$env:VX_TTS_RATE; $s.SetOutputToWaveFile($env:VX_TTS_OUT); $s.Speak($env:VX_TTS_TEXT); $s.Dispose()';
    try {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { VX_TTS_TEXT: req.text, VX_TTS_VOICE: req.voice, VX_TTS_RATE: String(rate), VX_TTS_OUT: file },
        timeoutMs: 15_000,
      });
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * eSpeak NG (`apt install espeak-ng`) — the recommended self-hosted Linux
 * provider. Text is written to stdin; SSML parsing (`-m`) is NOT enabled.
 * REQUIRES the espeak-ng binary; not installed in this dev environment.
 */
export class EspeakTtsService implements TTSService {
  readonly name = 'espeak' as const;
  readonly available = true;
  constructor(private readonly bin = 'espeak-ng') {}

  async listVoices() {
    const out = (await run(this.bin, ['--voices'])).toString('utf8');
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4)
      .map((c) => ({ id: c[3]!, name: c[3]!, locale: c[1]!, gender: c[2] === 'M' ? 'Male' : c[2] === 'F' ? 'Female' : undefined }));
  }

  async synthesize(req: TtsRequest) {
    const wpm = Math.round(175 * req.speed);
    const voice = (req.voice || req.locale.toLowerCase()).replace(/[^a-z0-9+_-]/gi, '');
    return run(this.bin, ['-v', voice, '-s', String(wpm), '--stdout'], { input: req.text });
  }
}

/**
 * Google Cloud Text-to-Speech REST API (`input.text`, never `input.ssml`).
 * REQUIRES TTS_GOOGLE_API_KEY — not exercised by the automated tests.
 */
export class GoogleTtsService implements TTSService {
  readonly name = 'google' as const;
  readonly available = true;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listVoices() {
    const res = await this.fetchImpl(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(this.apiKey)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new TtsError(`Google TTS voices returned ${res.status}`);
    const j = (await res.json()) as { voices?: Array<{ name: string; languageCodes: string[]; ssmlGender?: string }> };
    return (j.voices ?? []).map((v) => ({ id: v.name, name: v.name, locale: v.languageCodes[0] ?? '', gender: v.ssmlGender }));
  }

  async synthesize(req: TtsRequest) {
    const res = await this.fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: req.text },
        voice: { languageCode: req.locale, ...(req.voice ? { name: req.voice } : {}) },
        audioConfig: { audioEncoding: 'LINEAR16', speakingRate: req.speed, sampleRateHertz: 24000 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new TtsError(`Google TTS returned ${res.status}`);
    const j = (await res.json()) as { audioContent?: string };
    if (!j.audioContent) throw new TtsError('Google TTS returned no audio');
    return Buffer.from(j.audioContent, 'base64');
  }
}

/** Announcements switched off at the platform level (TTS_PROVIDER=none). */
export class NoTtsService implements TTSService {
  readonly name = 'none' as const;
  readonly available = false;
  async listVoices() {
    return [];
  }
  async synthesize(): Promise<Buffer> {
    throw new TtsError('Text-to-speech is not configured on this server');
  }
}

/**
 * ███ DEVELOPMENT / TEST ONLY ███
 * Does not speak words: produces a short deterministic chime + "syllable"
 * tones whose length follows the text, so queue timing and caching behave
 * realistically. Refused in production by config.ts. Tests can make it fail.
 */
export class MockTtsService implements TTSService {
  readonly name = 'mock' as const;
  readonly available = true;
  calls: TtsRequest[] = [];
  failNext = 0;
  failAlways = false;
  delayMs = 0;

  async listVoices() {
    return [
      { id: 'mock-en-f', name: 'Mock Nova (en-US)', locale: 'en-US', gender: 'Female' },
      { id: 'mock-en-m', name: 'Mock Atlas (en-US)', locale: 'en-US', gender: 'Male' },
      { id: 'mock-gb-f', name: 'Mock Iris (en-GB)', locale: 'en-GB', gender: 'Female' },
      { id: 'mock-es-m', name: 'Mock Sol (es-ES)', locale: 'es-ES', gender: 'Male' },
    ];
  }

  async synthesize(req: TtsRequest) {
    this.calls.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failAlways || this.failNext > 0) {
      if (this.failNext > 0) this.failNext--;
      throw new TtsError('Mock TTS failure');
    }
    const sr = 16000;
    const words = Math.max(1, req.text.split(/\s+/).length);
    const seconds = Math.min(4, (0.35 + words * 0.28) / req.speed);
    const n = Math.floor(seconds * sr);
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const chime = t < 0.3 ? Math.sin(2 * Math.PI * 1046 * t) * Math.exp(-t * 12) * 0.5 : 0;
      const syl = t >= 0.35 ? Math.abs(Math.sin(Math.PI * ((t - 0.35) * 3.6 * req.speed))) * Math.sin(2 * Math.PI * 190 * t) * 0.35 : 0;
      pcm[i] = chime + syl;
    }
    return encodeWav16([pcm], sr);
  }
}
