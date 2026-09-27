import { useMemo } from 'react';
import { Pause, Play } from 'lucide-react';
import { cx, fmtDuration } from '../../lib/format';
import { audioUrl, player, usePlayer } from './player';

/** Decorative bar waveform (peaks 0..1). The played portion is tinted. */
export function Waveform({ peaks, progress = 0, bars = 48, height = 36, color = 'var(--color-volt)', className }: { peaks: number[]; progress?: number; bars?: number; height?: number; color?: string; className?: string }) {
  const data = useMemo(() => {
    if (!peaks?.length) return Array.from({ length: bars }, (_, i) => 0.15 + 0.1 * Math.abs(Math.sin(i * 1.7)));
    return Array.from({ length: bars }, (_, i) => {
      const start = Math.floor((i / bars) * peaks.length);
      const end = Math.max(start + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let m = 0;
      for (let j = start; j < end; j++) m = Math.max(m, peaks[j] ?? 0);
      return Math.max(0.08, m);
    });
  }, [peaks, bars]);
  const w = 3;
  const gap = 2;
  const width = bars * (w + gap);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cx('w-full', className)} style={{ height }} aria-hidden>
      {data.map((v, i) => {
        const h = Math.max(2, v * height);
        const played = i / bars < progress;
        return <rect key={i} x={i * (w + gap)} y={(height - h) / 2} width={w} height={h} rx={1.5} fill={played ? color : 'var(--color-line-strong)'} />;
      })}
    </svg>
  );
}

/** Play/pause + waveform + duration for any stored audio file. */
export function AudioPreview({ audioId, peaks, durationMs, label, compact, color, overlayKey }: { audioId: string; peaks: number[]; durationMs?: number | null; label: string; compact?: boolean; color?: string; overlayKey?: string }) {
  const { playing, progress, error } = usePlayer(audioId);
  return (
    <div className={cx('flex min-w-0 items-center gap-3', compact ? '' : 'rounded-xl border border-line bg-canvas/60 p-2 pr-3')}>
      <button
        type="button"
        onClick={() => player.toggle(audioId, audioUrl(audioId, overlayKey))}
        aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
        aria-pressed={playing}
        className={cx(
          'flex shrink-0 items-center justify-center rounded-full transition-colors',
          compact ? 'size-9' : 'size-10',
          playing ? 'bg-volt text-on-volt' : 'bg-raised text-fg ring-1 ring-line hover:ring-line-strong',
        )}
      >
        {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
      </button>
      <Waveform peaks={peaks} progress={progress} height={compact ? 26 : 32} color={color} className="min-w-0 flex-1" />
      {durationMs != null && <span className="num shrink-0 text-xs text-muted">{fmtDuration(durationMs)}</span>}
      {error && <span className="sr-only" role="alert">{error}</span>}
    </div>
  );
}
