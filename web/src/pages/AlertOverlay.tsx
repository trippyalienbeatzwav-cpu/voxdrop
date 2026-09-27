import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Gift, HandCoins, Sparkles, Volume2 } from 'lucide-react';
import { Avatar } from '../components/ui/Feedback';
import { openResilientStream } from '../lib/resilientStream';

type AlertKind = 'subscription' | 'gift_sub' | 'donation';
type Animation = 'slide' | 'pop' | 'fade' | 'bounce';
type Position = 'top-left' | 'top' | 'top-right' | 'center' | 'bottom-left' | 'bottom' | 'bottom-right';

export interface AlertPayload {
  alertId: string;
  kind: AlertKind;
  isTest: boolean;
  text: string;
  viewerName: string;
  avatarUrl: string | null;
  giftCount: number | null;
  months: number | null;
  amount: string | null;
  message: string | null;
  customMessage: string | null;
  soundAudioId: string | null;
  ttsAudioId: string | null;
  animation: Animation;
  position: Position;
  durationMs: number;
  volume: number;
  accentColor: string | null;
}

const KIND_OF_PATH: Record<string, AlertKind> = { subscription: 'subscription', 'gift-sub': 'gift_sub', donation: 'donation' };
const LABEL: Record<AlertKind, string> = { subscription: 'New subscriber', gift_sub: 'Gift subs', donation: 'Donation' };
const ICON = { subscription: Sparkles, gift_sub: Gift, donation: HandCoins };

const POS: Record<Position, string> = {
  'top-left': 'items-start justify-start',
  top: 'items-start justify-center',
  'top-right': 'items-start justify-end',
  center: 'items-center justify-center',
  'bottom-left': 'items-end justify-start',
  bottom: 'items-end justify-center',
  'bottom-right': 'items-end justify-end',
};
const ENTER: Record<Animation, string> = {
  slide: 'alSlide 480ms cubic-bezier(.2,1,.3,1) both',
  pop: 'alPop 420ms cubic-bezier(.2,1.4,.4,1) both',
  fade: 'alFade 320ms ease-out both',
  bounce: 'alBounce 700ms cubic-bezier(.3,1.6,.5,1) both',
};

/** Sample data for ?preview=1 (never reported to the server). */
export function sampleAlert(kind: AlertKind, accent: string | null): AlertPayload {
  const text = kind === 'subscription' ? 'TrippyAlien just subscribed!' : kind === 'gift_sub' ? 'TrippyAlien gifted 5 subs!' : 'TrippyAlien donated $10.00!';
  return {
    alertId: `preview-${Date.now()}`,
    kind,
    isTest: true,
    text,
    viewerName: 'TrippyAlien',
    avatarUrl: null,
    giftCount: kind === 'gift_sub' ? 5 : null,
    months: kind === 'subscription' ? 1 : null,
    amount: kind === 'donation' ? '$10.00' : null,
    message: kind === 'donation' ? 'Love the stream!' : null,
    customMessage: null,
    soundAudioId: null,
    ttsAudioId: null,
    animation: 'slide',
    position: 'top',
    durationMs: 6000,
    volume: 80,
    accentColor: accent,
  };
}

/** Highlights the viewer name and amount inside the rendered (plain-text) template. */
function Highlighted({ a, accent }: { a: AlertPayload; accent: string }) {
  const marks = [a.viewerName, a.amount, a.giftCount ? String(a.giftCount) : null].filter((x): x is string => !!x);
  const parts: Array<{ t: string; hi: boolean }> = [];
  let rest = a.text;
  while (rest) {
    let best: { i: number; m: string } | null = null;
    for (const m of marks) {
      const i = rest.indexOf(m);
      if (i >= 0 && (!best || i < best.i)) best = { i, m };
    }
    if (!best) {
      parts.push({ t: rest, hi: false });
      break;
    }
    if (best.i) parts.push({ t: rest.slice(0, best.i), hi: false });
    parts.push({ t: best.m, hi: true });
    rest = rest.slice(best.i + best.m.length);
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hi ? (
          <span key={i} style={{ color: accent }}>
            {p.t}
          </span>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

/** Visual card, shared with the streamer's live preview on /streamer/alerts. */
export function AlertCard({ a, brand, progressKey }: { a: AlertPayload; brand: string; progressKey?: string | number }) {
  const accent = a.accentColor ?? brand;
  const Icon = ICON[a.kind];
  return (
    <div className="w-[min(720px,calc(100vw-3rem))] overflow-hidden rounded-3xl border border-white/10 bg-[#0A0B0E]/92 text-white" style={{ boxShadow: `0 0 0 1px ${accent}66, 0 24px 70px -20px ${accent}` }}>
      <div className="flex items-center gap-5 p-6">
        {a.avatarUrl ? (
          <Avatar src={a.avatarUrl} name={a.viewerName} size={72} ring={accent} />
        ) : (
          <span className="flex size-[72px] shrink-0 items-center justify-center rounded-2xl" style={{ background: `${accent}22`, color: accent }}>
            <Icon className="size-9" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em]" style={{ color: accent }}>
            {LABEL[a.kind]}
            {a.isTest && <span className="rounded bg-white/15 px-1.5 py-0.5 text-[11px] tracking-normal text-white">TEST</span>}
          </div>
          <div className="mt-1 break-words font-display text-3xl font-bold leading-tight">
            <Highlighted a={a} accent={accent} />
          </div>
          {a.message && <p className="mt-2 break-words text-xl text-white/90">“{a.message}”</p>}
          {a.customMessage && <p className="mt-1 text-lg text-white/75">{a.customMessage}</p>}
        </div>
      </div>
      <div key={progressKey} className="h-1.5 origin-left" style={{ background: accent, animation: `alBar ${a.durationMs}ms linear both` }} />
    </div>
  );
}

export const ALERT_KEYFRAMES = `
  @keyframes alSlide { from { opacity: 0; transform: translateY(-40px) scale(.98) } to { opacity: 1; transform: none } }
  @keyframes alPop { 0% { opacity: 0; transform: scale(.6) } 100% { opacity: 1; transform: scale(1) } }
  @keyframes alFade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes alBounce { 0% { opacity: 0; transform: translateY(-80px) } 60% { opacity: 1; transform: translateY(10px) } 100% { transform: none } }
  @keyframes alOut { to { opacity: 0; transform: translateY(-12px) scale(.98) } }
  @keyframes alBar { from { transform: scaleX(1) } to { transform: scaleX(0) } }
  @media (prefers-reduced-motion: reduce) { [data-alert] { animation: alFade 200ms ease-out both !important } }
`;

/**
 * Sub / gift-sub / donation OBS Browser Source:
 * /overlay/{streamerId}/{subscription|gift-sub|donation}?token=…
 * Each has its own secret token. Alerts are shown one at a time from a local
 * queue; the sound effect then the TTS line play back-to-back, driven by real
 * <audio> events, and the card stays up for at least the configured duration.
 * Display is acknowledged to the server (shown → completed).
 */
export default function AlertOverlay() {
  const { streamerId = '', kind: path = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const preview = params.get('preview') === '1';
  const kind = KIND_OF_PATH[path];
  const [brand, setBrand] = useState('#C6FF3D');
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'unauthorized'>('connecting');
  const [current, setCurrent] = useState<AlertPayload | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const queue = useRef<AlertPayload[]>([]);
  const seen = useRef(new Set<string>());
  const busy = useRef(false);
  const base = `/api/overlay/${encodeURIComponent(streamerId)}/${encodeURIComponent(path)}`;
  const tk = `token=${encodeURIComponent(token)}`;

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.title = 'VoxDrop alerts';
  }, []);

  const ack = useCallback(
    (a: AlertPayload, event: 'shown' | 'completed' | 'failed', detail?: string) => {
      if (a.alertId.startsWith('preview-')) return;
      void fetch(`${base}/ack?${tk}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alertId: a.alertId, event, detail }) }).catch(() => undefined);
    },
    [base, tk],
  );

  /** Plays one clip to its real end (or error). Resolves false if autoplay was blocked. */
  const playClip = useCallback(
    (audioId: string, volume: number) =>
      new Promise<boolean>((resolve) => {
        const el = new Audio(`/api/audio/${audioId}/stream?k=${encodeURIComponent(token)}`);
        el.volume = Math.max(0, Math.min(1, volume / 100));
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          resolve(ok);
        };
        el.addEventListener('ended', () => finish(true));
        el.addEventListener('error', () => finish(true)); // a broken clip never blocks the alert
        setTimeout(() => finish(true), 30_000); // hard cap per clip
        el.play().catch((err: Error) => {
          if (err.name === 'NotAllowedError') setNeedsGesture(true);
          finish(err.name !== 'NotAllowedError');
        });
      }),
    [token],
  );

  const pump = useCallback(async () => {
    if (busy.current) return;
    const a = queue.current.shift();
    if (!a) return;
    busy.current = true;
    setLeaving(false);
    setCurrent(a);
    ack(a, 'shown');
    const minShow = new Promise((r) => setTimeout(r, a.durationMs));
    try {
      if (a.soundAudioId) await playClip(a.soundAudioId, a.volume);
      if (a.ttsAudioId) await playClip(a.ttsAudioId, a.volume);
    } catch {
      /* audio problems never block the visual alert */
    }
    await minShow;
    setLeaving(true);
    await new Promise((r) => setTimeout(r, 350));
    setCurrent(null);
    ack(a, 'completed');
    busy.current = false;
    setTimeout(() => void pump(), 400);
  }, [ack, playClip]);

  const enqueue = useCallback(
    (a: AlertPayload) => {
      if (seen.current.has(a.alertId)) return; // backlog replay + live event can overlap
      seen.current.add(a.alertId);
      queue.current.push(a);
      void pump();
    },
    [pump],
  );

  useEffect(() => {
    if (!kind || !token) {
      setStatus('unauthorized');
      return;
    }
    let closeStream: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${base}?${tk}`);
      if (cancelled) return;
      if (!res.ok) {
        setStatus(res.status === 404 || res.status === 422 ? 'unauthorized' : 'error');
        return;
      }
      const init = (await res.json()) as { streamer: { brandColor: string }; alert: { accentColor: string | null; position: Position; animation: Animation; durationMs: number } };
      setBrand(init.streamer.brandColor);
      if (preview) {
        setStatus('live');
        enqueue({ ...sampleAlert(kind, init.alert.accentColor), position: init.alert.position, animation: init.alert.animation, durationMs: init.alert.durationMs });
        return;
      }
      // Each (re)connect replays alerts from the last 2 minutes that were never shown; `seen` dedupes.
      closeStream = openResilientStream(`${base}/events?${tk}`, { 'alert.show': (d) => enqueue(d as AlertPayload) }, setStatus);
    })().catch(() => setStatus('error'));
    return () => {
      cancelled = true;
      closeStream?.();
    };
  }, [base, tk, kind, token, preview, enqueue]);

  if (status === 'unauthorized')
    return <div className="p-6 font-sans text-sm text-white/80">Alert overlay URL is invalid or was regenerated. Copy the current URL from VoxDrop Studio → OBS Overlays.</div>;

  return (
    <div className={`pointer-events-none fixed inset-0 flex p-10 font-sans ${POS[current?.position ?? 'top']}`}>
      <style>{ALERT_KEYFRAMES}</style>
      {current && (
        <div key={current.alertId} data-alert style={{ animation: leaving ? 'alOut 320ms ease-in both' : ENTER[current.animation] }} role="status" aria-live="polite">
          <AlertCard a={current} brand={brand} progressKey={current.alertId} />
        </div>
      )}
      {needsGesture && (
        <button className="pointer-events-auto absolute bottom-4 right-4 flex items-center gap-2 rounded-xl bg-black/80 px-4 py-2 text-sm text-white" onClick={() => setNeedsGesture(false)}>
          <Volume2 className="size-4" /> Click to enable alert sounds (not needed in OBS)
        </button>
      )}
      {status !== 'live' && <div className="absolute right-3 top-3 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-white/70">{status === 'error' ? 'VoxDrop: connection error' : 'VoxDrop: connecting…'}</div>}
      {preview && <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-white/70">Preview — sample alert, not live</div>}
    </div>
  );
}
