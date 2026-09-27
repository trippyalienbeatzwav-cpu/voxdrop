import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Coins, FileAudio, Megaphone, MessageSquare, Mic, Music2, Volume2 } from 'lucide-react';
import { fmtMoney, fmtPoints } from '../lib/format';
import type { Message } from '../lib/types';
import { Avatar } from '../components/ui/Feedback';
import { SoundIcon } from '../components/shared';
import { openResilientStream } from '../lib/resilientStream';
import { OverlayPlayer, type AudioLike, type PlaybackEventName, type PlayItem, type Stage } from '../lib/overlayPlayer';

interface PlayPayload extends PlayItem {
  message: Message;
}
interface OverlaySettings {
  paused: boolean;
  volume: number;
  announcementVolume: number;
  alertStyle: 'slide' | 'pop' | 'minimal';
  alertDurationMs: number;
  showAvatar: boolean;
  showPoints: boolean;
}

const TYPE_ICON = { TEXT: MessageSquare, VOICE: Mic, MP3: FileAudio, SOUND: Music2 };

/**
 * Voice / MP3 / sound OBS Browser Source: /overlay/{streamerId}/audio?token=…
 * Transparent background, no app chrome, authenticated by the audio overlay's
 * own secret token. Sub / gift-sub / donation alerts are separate Browser
 * Sources (AlertOverlay). Playback sequencing (announcement → viewer audio,
 * driven only by real media events) lives in OverlayPlayer.
 */
export default function Overlay() {
  const { streamerId = '' } = useParams();
  const [params] = useSearchParams();
  const key = params.get('token') ?? '';
  const [brand, setBrand] = useState('#C6FF3D');
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [current, setCurrent] = useState<PlayPayload | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'unauthorized'>('connecting');
  const [needsGesture, setNeedsGesture] = useState(false);
  const base = `/api/overlay/${encodeURIComponent(streamerId)}/audio`;
  const k = `token=${encodeURIComponent(key)}`;

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.title = 'VoxDrop overlay';
  }, []);

  /** Reports survive brief network drops: 3 attempts with backoff; 4xx answers are final. */
  const report = useCallback(
    async (itemId: string, event: PlaybackEventName, detail?: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${base}/playback?${k}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, event, detail }) });
          if (res.status < 500) return;
        } catch {
          /* network error → retry */
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    },
    [base, k],
  );

  const player = useMemo(
    () =>
      new OverlayPlayer({
        createAudio: () => {
          const a = new Audio();
          a.preload = 'auto';
          return a as unknown as AudioLike;
        },
        audioUrl: (id) => `/api/audio/${id}/stream?k=${encodeURIComponent(key)}`,
        report,
        onStage: (s, item) => {
          setStage(s);
          if (s === 'idle') setTimeout(() => setCurrent((c) => (c && player.current?.itemId !== c.itemId ? null : c)), 500);
          else setCurrent(item as PlayPayload);
        },
        onNeedsGesture: () => setNeedsGesture(true), // OBS allows autoplay; regular browsers may not
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, report],
  );

  const play = useCallback((p: PlayPayload) => player.play(p), [player]);
  const stop = useCallback((itemId?: string) => player.stop(itemId), [player]);

  useEffect(() => {
    if (!key) {
      setStatus('unauthorized');
      return;
    }
    let closeStream: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${base}?${k}`);
      if (cancelled) return;
      if (!res.ok) {
        setStatus(res.status === 404 ? 'unauthorized' : 'error');
        return;
      }
      const init = (await res.json()) as { streamer: { brandColor: string }; settings: OverlaySettings; current: PlayPayload | null };
      setBrand(init.streamer.brandColor);
      setSettings(init.settings);
      player.setVolumes({ volume: init.settings.volume, announcementVolume: init.settings.announcementVolume });
      if (init.settings.paused) player.pause();
      if (init.current) play(init.current); // reconnect mid-item: resumes at the right phase
      closeStream = openResilientStream(
        `${base}/events?${k}`,
        {
          'overlay.play': (d) => play(d as PlayPayload),
          'overlay.stop': (d) => stop((d as { itemId?: string } | null)?.itemId),
          'overlay.settings': (raw) => {
            const d = raw as Partial<OverlaySettings> & { brandColor?: string };
            if (d.brandColor) setBrand(d.brandColor);
            setSettings((s) => (s ? { ...s, ...d } : s));
            player.setVolumes(d);
            if (d.paused === true) player.pause();
            if (d.paused === false) player.resume();
          },
          'overlay.announcement_test': (raw) => {
            if (player.current) return; // never interrupt a live item
            const d = raw as { audioId: string; volume: number };
            const a = new Audio(`/api/audio/${d.audioId}/stream?k=${encodeURIComponent(key)}`);
            a.volume = Math.max(0, Math.min(1, d.volume / 100));
            void a.play().catch(() => setNeedsGesture(true));
          },
        },
        setStatus,
        // After an outage, re-sync the item the server thinks is playing.
        () =>
          void fetch(`${base}?${k}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { current: PlayPayload | null } | null) => {
              if (j?.current && player.current?.itemId !== j.current.itemId) play(j.current);
            })
            .catch(() => undefined),
      );
    })().catch(() => setStatus('error'));
    return () => {
      cancelled = true;
      closeStream?.();
      player.stop();
    };
  }, [base, k, key, play, stop, player]);

  const style = settings?.alertStyle ?? 'slide';
  const enter = style === 'pop' ? 'animate-[ovPop_420ms_cubic-bezier(.2,1.4,.4,1)_both]' : style === 'minimal' ? 'animate-[ovFade_300ms_ease-out_both]' : 'animate-[ovSlide_450ms_cubic-bezier(.2,1,.3,1)_both]';

  if (status === 'unauthorized')
    return <div className="p-6 font-sans text-sm text-white/80">Overlay URL is invalid or was rotated. Copy the current URL from VoxDrop Studio → OBS Overlays.</div>;

  const m = current?.message;
  const Icon = m ? TYPE_ICON[m.type] : Mic;
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden font-sans text-white" style={{ ['--brand' as string]: brand }}>
      <style>{`
        @keyframes ovSlide { from { opacity: 0; transform: translateY(40px) scale(.98) } to { opacity: 1; transform: none } }
        @keyframes ovPop { 0% { opacity: 0; transform: scale(.6) } 100% { opacity: 1; transform: scale(1) } }
        @keyframes ovFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes ovBar { from { transform: scaleX(1) } to { transform: scaleX(0) } }
        @keyframes ovEq { 0%,100% { transform: scaleY(.35) } 50% { transform: scaleY(1) } }
      `}</style>

      {/* Now playing card — bottom left */}
      {current && m && (
        <div key={current.itemId} className={`absolute bottom-12 left-12 w-[640px] max-w-[calc(100vw-6rem)] ${enter}`}>
          <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#0A0B0E]/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]" style={{ boxShadow: `0 0 0 1px ${brand}55, 0 30px 80px -20px ${brand}55` }}>
            <div className="flex items-center gap-5 p-6">
              {settings?.showAvatar !== false && (m.sound ? <SoundIcon icon={m.sound.icon} color={m.sound.color} size={72} /> : <Avatar src={m.sender.avatarUrl} name={m.sender.displayName} size={72} ring={brand} />)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em]" style={{ color: brand }}>
                  <Icon className="size-4" /> {m.donation ? 'Donation' : m.type === 'SOUND' ? 'Sound' : m.type === 'TEXT' ? 'Message' : 'Voice message'}
                </div>
                <div className="mt-1 truncate font-display text-3xl font-bold">{m.sender.displayName}</div>
                {stage === 'announcing' && current.announcement?.text && (
                  <div className="mt-1 flex items-center gap-2 text-base font-medium text-white/80">
                    <Megaphone className="size-4" style={{ color: brand }} /> {current.announcement.text}
                  </div>
                )}
                {m.sound && <div className="text-lg text-white/80">played {m.sound.name}</div>}
              </div>
              <div className="flex flex-col items-end gap-1">
                {m.donation && <div className="font-display text-3xl font-bold text-[#FF3D8B]">{fmtMoney(m.donation.amountCents, m.donation.currency)}</div>}
                {settings?.showPoints !== false && m.pointsSpent > 0 && (
                  <div className="flex items-center gap-1.5 font-mono text-xl font-semibold" style={{ color: brand }}>
                    <Coins className="size-5" /> {fmtPoints(m.pointsSpent)}
                  </div>
                )}
              </div>
            </div>
            {m.text && stage !== 'announcing' && <p className="px-6 pb-5 text-2xl font-medium leading-snug text-white/95">{m.text}</p>}
            {m.audio && stage === 'message' && (
              <div className="flex h-10 items-end gap-1 px-6 pb-5" aria-hidden>
                {Array.from({ length: 40 }, (_, i) => (
                  <span key={i} className="w-1.5 flex-1 origin-bottom rounded-full" style={{ height: `${30 + 70 * (m.audio!.waveform[Math.floor((i / 40) * m.audio!.waveform.length)] ?? 0.4)}%`, background: brand, animation: `ovEq ${0.6 + (i % 5) * 0.12}s ease-in-out ${i * 0.03}s infinite` }} />
                ))}
              </div>
            )}
            {stage !== 'announcing' && <div key={stage} className="h-1.5 origin-left" style={{ background: brand, animation: `ovBar ${current.durationMs}ms linear both` }} />}
          </div>
        </div>
      )}

      {needsGesture && (
        <button className="pointer-events-auto absolute bottom-4 right-4 flex items-center gap-2 rounded-xl bg-black/80 px-4 py-2 text-sm" onClick={() => { setNeedsGesture(false); player.unlock(); }}>
          <Volume2 className="size-4" /> Click to enable audio (not needed in OBS)
        </button>
      )}
      {status !== 'live' && <div className="absolute right-3 top-3 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-white/70">{status === 'error' ? 'VoxDrop: connection error' : 'VoxDrop: connecting…'}</div>}
    </div>
  );
}
