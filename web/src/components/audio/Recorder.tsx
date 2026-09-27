import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, Mic, MicOff, Pause, Play, RotateCcw, Scissors, Send, Square, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { cx, fmtDuration } from '../../lib/format';
import { decodeToMono, encodeWav, peakAmplitude, peaksOf, resample, TARGET_RATE } from './wav';
import { player, usePlayer } from './player';
import { Waveform } from './Waveform';

type Phase = 'ready' | 'requesting' | 'recording' | 'paused' | 'processing' | 'preview' | 'uploading' | 'sent' | 'error';

const PHASE_LABEL: Record<Phase, string> = {
  ready: 'Ready to record',
  requesting: 'Waiting for microphone…',
  recording: 'Recording',
  paused: 'Paused',
  processing: 'Processing…',
  preview: 'Preview',
  uploading: 'Uploading…',
  sent: 'Sent!',
  error: 'Something went wrong',
};

const MIN_SECONDS = 0.5;

export interface RecorderProps {
  maxSeconds: number;
  onSend: (wav: Blob, durationMs: number, onProgress: (pct: number) => void) => Promise<void>;
  sendLabel: ReactNode;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  /** Rendered between the preview and the send button (message text, priority…). */
  children?: ReactNode;
  onReset?: () => void;
  sentContent?: ReactNode;
}

export function Recorder({ maxSeconds, onSend, sendLabel, sendDisabled, sendDisabledReason, children, onReset, sentContent }: RecorderProps) {
  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [clip, setClip] = useState<{ pcm: Float32Array; sampleRate: number } | null>(null);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [uploadPct, setUploadPct] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef<number>(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<number[]>([]);
  const clock = useRef({ start: 0, accumulated: 0 });
  const previewPlayer = usePlayer('recorder-preview');

  const cleanupStream = useCallback(() => {
    cancelAnimationFrame(raf.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    analyser.current = null;
  }, []);

  useEffect(() => () => {
    cleanupStream();
    player.stop();
  }, [cleanupStream]);

  const draw = useCallback(() => {
    const a = analyser.current;
    const c = canvas.current;
    if (!a || !c) return;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let rms = 0;
    for (const s of buf) rms += s * s;
    rms = Math.sqrt(rms / buf.length);
    const lvl = Math.min(1, rms * 4);
    setLevel(lvl);
    if (recRef.current?.state === 'recording') {
      history.current.push(lvl);
      if (history.current.length > 120) history.current.shift();
      const now = performance.now();
      const secs = (clock.current.accumulated + (now - clock.current.start)) / 1000;
      setElapsed(secs);
      if (secs >= maxSeconds) {
        stop();
        return;
      }
    }
    const g = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    g.clearRect(0, 0, w, h);
    const bars = history.current;
    const bw = 4 * dpr;
    const gap = 3 * dpr;
    const n = Math.floor(w / (bw + gap));
    const slice = bars.slice(-n);
    const volt = getComputedStyle(document.documentElement).getPropertyValue('--color-volt') || '#ffd43b';
    slice.forEach((v, i) => {
      const bh = Math.max(3 * dpr, v * h * 0.9);
      const x = w - (slice.length - i) * (bw + gap);
      g.fillStyle = volt;
      g.globalAlpha = 0.35 + 0.65 * (i / slice.length);
      g.beginPath();
      g.roundRect(x, (h - bh) / 2, bw, bh, bw / 2);
      g.fill();
    });
    g.globalAlpha = 1;
    raf.current = requestAnimationFrame(draw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxSeconds]);

  async function start() {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      analyser.current = an;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
      chunks.current = [];
      history.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => void finish(new Blob(chunks.current, { type: rec.mimeType }));
      recRef.current = rec;
      rec.start(250);
      clock.current = { start: performance.now(), accumulated: 0 };
      setElapsed(0);
      setPhase('recording');
      raf.current = requestAnimationFrame(draw);
    } catch (err) {
      cleanupStream();
      const name = (err as DOMException).name;
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Plug one in or use “Upload audio” instead.'
            : 'Could not start the microphone.',
      );
      setPhase('error');
    }
  }

  function pause() {
    const r = recRef.current;
    if (r?.state !== 'recording') return;
    r.pause();
    clock.current.accumulated += performance.now() - clock.current.start;
    setPhase('paused');
  }
  function resume() {
    const r = recRef.current;
    if (r?.state !== 'paused') return;
    r.resume();
    clock.current.start = performance.now();
    setPhase('recording');
  }
  function stop() {
    const r = recRef.current;
    if (!r || r.state === 'inactive') return;
    if (r.state === 'recording') clock.current.accumulated += performance.now() - clock.current.start;
    setPhase('processing');
    r.stop();
  }

  async function finish(blob: Blob) {
    cleanupStream();
    try {
      const decoded = await decodeToMono(blob);
      const secs = decoded.pcm.length / decoded.sampleRate;
      if (secs < MIN_SECONDS) throw new Error('That recording is too short — hold on a little longer.');
      if (peakAmplitude(decoded.pcm) < 0.01) throw new Error('We couldn’t hear anything. Check your microphone and try again.');
      setClip(decoded);
      setTrim([0, Math.min(secs, maxSeconds)]);
      setPhase('preview');
    } catch (err) {
      setError((err as Error).message || 'Could not process the recording.');
      setPhase('error');
    }
  }

  const duration = clip ? clip.pcm.length / clip.sampleRate : 0;
  const peaks = useMemo(() => (clip ? peaksOf(clip.pcm, 96) : []), [clip]);
  const trimmedSecs = Math.max(0, trim[1] - trim[0]);

  const buildWav = useCallback(async () => {
    if (!clip) throw new Error('No recording');
    const a = Math.floor(trim[0] * clip.sampleRate);
    const b = Math.floor(trim[1] * clip.sampleRate);
    const seg = clip.pcm.slice(a, b);
    return encodeWav(await resample(seg, clip.sampleRate, TARGET_RATE), TARGET_RATE);
  }, [clip, trim]);

  // Rebuild the preview when the trim changes (debounced).
  useEffect(() => {
    if (phase !== 'preview' || !clip) return;
    const t = setTimeout(async () => {
      player.stop();
      const wav = await buildWav();
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(wav);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [trim, clip, phase, buildWav]);

  function reset() {
    player.stop();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setClip(null);
    setElapsed(0);
    setError(null);
    setUploadPct(0);
    setPhase('ready');
    onReset?.();
  }

  async function send() {
    if (trimmedSecs < MIN_SECONDS) {
      setError('The trimmed clip is too short.');
      return;
    }
    setError(null);
    setPhase('uploading');
    try {
      player.stop();
      const wav = await buildWav();
      await onSend(wav, Math.round(trimmedSecs * 1000), setUploadPct);
      setPhase('sent');
    } catch (err) {
      setError((err as Error).message);
      setPhase('preview');
    }
  }

  const pct = Math.min(1, elapsed / maxSeconds);
  const live = phase === 'recording' || phase === 'paused';

  return (
    <section className="card overflow-hidden" aria-label="Voice recorder">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
          <span className={cx('size-2 rounded-full', phase === 'recording' ? 'animate-pulse-dot bg-danger' : phase === 'sent' ? 'bg-success' : 'bg-line-strong')} aria-hidden />
          {PHASE_LABEL[phase]}
        </div>
        <span className="text-xs text-subtle">Max {maxSeconds}s</span>
      </div>

      <div className="p-5">
        {(phase === 'ready' || phase === 'requesting' || live || phase === 'processing') && (
          <div className="flex flex-col items-center gap-5">
            <div className="relative h-24 w-full overflow-hidden rounded-xl bg-canvas ring-1 ring-line">
              <canvas ref={canvas} className="size-full" aria-hidden />
              {!live && phase !== 'processing' && (
                <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-subtle">Press record and speak — your voice appears here.</p>
              )}
              {phase === 'processing' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Preparing preview…
                </div>
              )}
            </div>

            <div className="flex w-full items-center gap-4">
              <div className="num font-display text-3xl font-semibold tabular-nums" aria-label={`Elapsed ${Math.floor(elapsed)} seconds of ${maxSeconds}`}>
                {fmtDuration(elapsed * 1000)}
                <span className="text-lg text-subtle"> / {fmtDuration(maxSeconds * 1000)}</span>
              </div>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay" aria-hidden>
                <div className={cx('h-full rounded-full transition-[width] duration-200', pct > 0.85 ? 'bg-amber' : 'bg-volt')} style={{ width: `${pct * 100}%` }} />
              </div>
            </div>

            <div className="flex w-full items-center gap-3" >
              <MicOff className={cx('size-4', live ? 'hidden' : 'text-subtle')} aria-hidden />
              <Mic className={cx('size-4 text-volt', live ? '' : 'hidden')} aria-hidden />
              <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="flex h-2 flex-1 gap-0.5">
                {Array.from({ length: 24 }, (_, i) => (
                  <span key={i} className={cx('flex-1 rounded-sm transition-colors duration-75', live && level * 24 > i ? (i > 19 ? 'bg-danger' : i > 14 ? 'bg-amber' : 'bg-volt') : 'bg-overlay')} />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              {!live ? (
                <button
                  type="button"
                  onClick={start}
                  disabled={phase === 'requesting' || phase === 'processing'}
                  aria-label="Start recording"
                  className="group relative flex size-20 items-center justify-center rounded-full bg-danger text-white shadow-[0_0_0_6px_rgb(255_90_95/0.15),0_12px_32px_-8px_rgb(255_90_95/0.6)] transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
                >
                  <Mic className="size-8" aria-hidden />
                </button>
              ) : (
                <>
                  {phase === 'recording' ? (
                    <Button onClick={pause} icon={<Pause className="size-4" />} aria-label="Pause recording">
                      Pause
                    </Button>
                  ) : (
                    <Button onClick={resume} icon={<Mic className="size-4" />} aria-label="Resume recording">
                      Resume
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={stop}
                    aria-label="Stop recording"
                    className="flex size-20 items-center justify-center rounded-full bg-fg text-canvas shadow-lg transition-transform hover:scale-105 active:scale-95"
                  >
                    <Square className="size-7" fill="currentColor" aria-hidden />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {(phase === 'preview' || phase === 'uploading') && clip && (
          <div className="space-y-5">
            <div className="rounded-xl bg-canvas p-4 ring-1 ring-line">
              <div className="relative">
                <Waveform peaks={peaks} bars={96} height={72} progress={previewPlayer.playing ? trim[0] / duration + previewPlayer.progress * (trimmedSecs / duration) : 0} />
                <div className="pointer-events-none absolute inset-y-0 left-0 bg-canvas/75" style={{ width: `${(trim[0] / duration) * 100}%` }} />
                <div className="pointer-events-none absolute inset-y-0 right-0 bg-canvas/75" style={{ width: `${(1 - trim[1] / duration) * 100}%` }} />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <Scissors className="size-3.5" aria-hidden /> Trim start · <span className="num text-fg">{trim[0].toFixed(1)}s</span>
                  </span>
                  <input type="range" min={0} max={duration} step={0.1} value={trim[0]} disabled={phase === 'uploading'} onChange={(e) => setTrim(([, b]) => [Math.min(Number(e.target.value), b - MIN_SECONDS), b])} className="accent-[var(--color-volt)]" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <Scissors className="size-3.5" aria-hidden /> Trim end · <span className="num text-fg">{trim[1].toFixed(1)}s</span>
                  </span>
                  <input type="range" min={0} max={duration} step={0.1} value={trim[1]} disabled={phase === 'uploading'} onChange={(e) => setTrim(([a]) => [a, Math.max(Number(e.target.value), a + MIN_SECONDS)])} className="accent-[var(--color-volt)]" />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => previewUrl && player.toggle('recorder-preview', previewUrl)}
                  disabled={!previewUrl || phase === 'uploading'}
                  icon={previewPlayer.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                >
                  {previewPlayer.playing ? 'Pause' : 'Replay'}
                </Button>
                <Button size="sm" variant="ghost" onClick={reset} disabled={phase === 'uploading'} icon={<Trash2 className="size-4" />}>
                  Delete & re-record
                </Button>
                <span className="num ml-auto text-sm text-muted">{fmtDuration(trimmedSecs * 1000)} selected</span>
              </div>
            </div>

            {children}

            {phase === 'uploading' && (
              <div className="space-y-1.5" role="progressbar" aria-label="Upload progress" aria-valuenow={uploadPct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                  <div className="h-full rounded-full bg-volt transition-[width]" style={{ width: `${Math.max(uploadPct, 4)}%` }} />
                </div>
                <p className="text-xs text-muted">{uploadPct < 100 ? `Uploading… ${uploadPct}%` : 'Validating on the server…'}</p>
              </div>
            )}
            {error && (
              <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                {error}
              </p>
            )}
            <Button variant="primary" size="lg" className="w-full" onClick={send} loading={phase === 'uploading'} disabled={sendDisabled} icon={<Send className="size-4" />}>
              {sendLabel}
            </Button>
            {sendDisabled && sendDisabledReason && <p className="text-center text-sm text-amber">{sendDisabledReason}</p>}
          </div>
        )}

        {phase === 'sent' && (
          <div className="flex animate-rise flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="size-12 text-success" aria-hidden />
            <h3 className="text-xl font-semibold">Voice message sent</h3>
            {sentContent}
            <Button onClick={reset} icon={<RotateCcw className="size-4" />}>
              Record another
            </Button>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col items-center gap-3 py-6 text-center" role="alert">
            <MicOff className="size-10 text-danger" aria-hidden />
            <p className="max-w-sm text-sm text-muted">{error}</p>
            <Button onClick={reset} icon={<RotateCcw className="size-4" />}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
