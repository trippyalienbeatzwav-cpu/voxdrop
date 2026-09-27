import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AudioLines, Bell, Bomb, Clock, Crown, Drum, FileAudio, Flag, Flame, Gamepad2, Ghost, HandCoins, HandMetal, Heart, Laugh, Megaphone, MessageSquare,
  Mic, Music, Music2, PartyPopper, Pause, Play, Rocket, Siren, Skull, Sparkles, Star, Swords, Target, ThumbsUp, Trophy, Volume2, Zap, type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { get } from '../lib/api';
import { cx, fmtDuration, fmtMoney, fmtPoints, fmtRelative } from '../lib/format';
import type { Message, MessageType, Page, Sound, Streamer } from '../lib/types';
import { Avatar, Badge, LiveBadge, Points, StatusBadge } from './ui/Feedback';
import { Button } from './ui/Button';
import { AudioPreview } from './audio/Waveform';
import { audioUrl, player, usePlayer } from './audio/player';

export const TYPE_META: Record<MessageType, { label: string; icon: ReactNode; tone: 'cyan' | 'volt' | 'violet' | 'magenta' }> = {
  TEXT: { label: 'Text', icon: <MessageSquare className="size-3.5" aria-hidden />, tone: 'cyan' },
  VOICE: { label: 'Voice', icon: <Mic className="size-3.5" aria-hidden />, tone: 'volt' },
  MP3: { label: 'Audio clip', icon: <FileAudio className="size-3.5" aria-hidden />, tone: 'violet' },
  SOUND: { label: 'Sound', icon: <Music2 className="size-3.5" aria-hidden />, tone: 'magenta' },
};

export function TypeBadge({ type }: { type: MessageType }) {
  const m = TYPE_META[type];
  return (
    <Badge tone={m.tone}>
      {m.icon}
      {m.label}
    </Badge>
  );
}

/** Keyset-paginated list hook (never loads full history at once). */
export function usePaged<T>(key: unknown[], url: (cursor?: string) => string, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: key,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => get<Page<T>>(url(pageParam), signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...q, items };
}

export function LoadMore({ q }: { q: { hasNextPage?: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!q.hasNextPage) return null;
  return (
    <div className="flex justify-center pt-4">
      <Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
        Load more
      </Button>
    </div>
  );
}

/** A message as shown in history, moderation and the queue. `actions` slot for staff controls. */
export function MessageCard({ m, actions, showStreamer, selected, onSelect, footer, dense }: { m: Message; actions?: ReactNode; showStreamer?: boolean; selected?: boolean; onSelect?: () => void; footer?: ReactNode; dense?: boolean }) {
  return (
    <article
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cx('card relative flex flex-col gap-3 p-4 transition-[border-color,box-shadow]', selected && 'border-volt/50 shadow-[0_0_0_1px_rgb(255_212_59/0.35)]', onSelect && 'cursor-pointer', m.isPriority && 'bg-gradient-to-br from-volt/[0.04] to-transparent')}
    >
      <header className="flex items-start gap-3">
        <Avatar src={m.sender.avatarUrl} name={m.sender.displayName} size={dense ? 36 : 44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-semibold">{m.sender.displayName}</span>
            {showStreamer && (
              <span className="text-sm text-subtle">
                → <Link className="hover:text-fg" to={`/streamer/${m.streamer.slug}`} onClick={(e) => e.stopPropagation()}>{m.streamer.displayName}</Link>
              </span>
            )}
            <span className="text-xs text-subtle">
              <time dateTime={m.createdAt}>{fmtRelative(m.createdAt)}</time>
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <TypeBadge type={m.type} />
            <StatusBadge status={m.status} />
            {m.isPriority && (
              <Badge tone="volt">
                <Zap className="size-3" aria-hidden /> Priority
              </Badge>
            )}
            {m.donation && (
              <Badge tone="magenta">
                <HandCoins className="size-3" aria-hidden /> {fmtMoney(m.donation.amountCents, m.donation.currency)}
              </Badge>
            )}
            {m.flagged && (
              <Badge tone="danger">
                <Flag className="size-3" aria-hidden /> {m.flagReason ?? 'Flagged'}
              </Badge>
            )}
            {m.audio?.durationMs != null && (
              <Badge>
                <Clock className="size-3" aria-hidden /> {fmtDuration(m.audio.durationMs)}
              </Badge>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {m.pointsSpent > 0 ? <Points value={m.pointsSpent} /> : !m.donation && <span className="text-xs font-medium text-subtle">Free</span>}
        </div>
      </header>
      {m.sound && (
        <div className="flex items-center gap-2 text-sm">
          <SoundIcon icon={m.sound.icon} color={m.sound.color} size={28} />
          <span className="font-medium">{m.sound.name}</span>
        </div>
      )}
      {m.text && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg/90">{m.text}</p>}
      {m.audio && <div onClick={(e) => e.stopPropagation()}><AudioPreview audioId={m.audio.id} peaks={m.audio.waveform} durationMs={m.audio.durationMs} label={`message from ${m.sender.displayName}`} /></div>}
      {m.rejectionReason && m.status === 'REJECTED' && <p className="text-sm text-danger">Reason: {m.rejectionReason}</p>}
      {actions && <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3" onClick={(e) => e.stopPropagation()}>{actions}</div>}
      {footer}
    </article>
  );
}

/** Must mirror SOUND_ICONS on the server (explicit map keeps the bundle tree-shaken). */
export const SOUND_ICON_MAP: Record<string, LucideIcon> = {
  'volume-2': Volume2, megaphone: Megaphone, 'party-popper': PartyPopper, laugh: Laugh, skull: Skull, flame: Flame, zap: Zap, heart: Heart, star: Star,
  bell: Bell, drum: Drum, music: Music, siren: Siren, trophy: Trophy, ghost: Ghost, sparkles: Sparkles, swords: Swords, 'gamepad-2': Gamepad2,
  'thumbs-up': ThumbsUp, 'hand-metal': HandMetal, rocket: Rocket, bomb: Bomb, crown: Crown, target: Target,
};

export function SoundIcon({ icon, color, size = 40 }: { icon: string; color: string; size?: number }) {
  const C = SOUND_ICON_MAP[icon] ?? AudioLines;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size, height: size, background: `${color}1f`, color, boxShadow: `inset 0 0 0 1px ${color}40` }} aria-hidden>
      <C style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

/** Soundboard / library card: icon, name, price, preview, cooldown & availability. */
export function SoundCard({ s, onUse, useLabel = 'Use', busy, disabled, extra }: { s: Sound; onUse?: () => void; useLabel?: string; busy?: boolean; disabled?: boolean; extra?: ReactNode }) {
  const { playing, progress } = usePlayer(s.audioFileId);
  const cooling = s.cooldownRemaining > 0;
  return (
    <div className={cx('card group relative flex flex-col gap-3 p-4 transition-colors hover:border-line-strong', !s.isActive && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <SoundIcon icon={s.icon} color={s.color} size={48} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{s.name}</h3>
          <p className="text-xs text-subtle">
            {s.category.name} · {fmtDuration(s.durationMs)}
          </p>
        </div>
        <button
          onClick={() => player.toggle(s.audioFileId, audioUrl(s.audioFileId))}
          aria-label={`${playing ? 'Stop' : 'Preview'} ${s.name}`}
          aria-pressed={playing}
          className={cx('flex size-10 shrink-0 items-center justify-center rounded-full transition-colors', playing ? 'bg-volt text-on-volt' : 'bg-raised text-fg ring-1 ring-line hover:ring-line-strong')}
        >
          {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
        </button>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-overlay" aria-hidden>
        <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${playing ? progress * 100 : 0}%`, background: s.color }} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        {!s.isActive ? (
          <Badge>Disabled</Badge>
        ) : cooling ? (
          <Badge tone="amber">
            <Clock className="size-3" aria-hidden /> {s.cooldownRemaining}s cooldown
          </Badge>
        ) : s.dailyLimit > 0 && s.usesToday >= s.dailyLimit ? (
          <Badge tone="danger">Daily limit reached</Badge>
        ) : (
          <Badge tone="success">Available</Badge>
        )}
        <span className="text-subtle">{s.cooldownSeconds ? `${s.cooldownSeconds}s cd` : 'No cooldown'}</span>
      </div>
      {extra}
      {onUse && (
        <Button variant={s.available ? 'primary' : 'secondary'} onClick={onUse} loading={busy} disabled={disabled || !s.available} className="w-full">
          {useLabel} · <span className="num">{fmtPoints(s.pricePoints)}</span>
        </Button>
      )}
    </div>
  );
}

export function StreamerCard({ s }: { s: Streamer }) {
  return (
    <Link to={`/streamer/${s.slug}`} className="card group flex flex-col overflow-hidden transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong">
      <div className="relative h-20" style={{ background: `linear-gradient(135deg, ${s.brandColor}33, transparent 70%), var(--color-raised)` }}>
        <div className="absolute right-3 top-3">
          <LiveBadge live={s.isLive} />
        </div>
      </div>
      <div className="-mt-8 flex flex-1 flex-col gap-3 p-4 pt-0">
        <Avatar src={s.avatarUrl} name={s.displayName} size={56} ring={s.isLive ? 'var(--color-magenta)' : undefined} />
        <div>
          <h3 className="font-semibold group-hover:text-volt">{s.displayName}</h3>
          <p className="text-xs text-subtle">kick.com/{s.slug}</p>
        </div>
        {s.isLive && s.liveTitle && <p className="line-clamp-1 text-sm text-muted">{s.liveTitle}</p>}
        <div className="mt-auto flex flex-wrap gap-1.5 text-xs">
          {s.voiceEnabled && (
            <Badge tone="volt">
              <Mic className="size-3" aria-hidden /> Voice {fmtPoints(s.priceVoice)}
            </Badge>
          )}
          {!!s.soundCount && (
            <Badge tone="magenta">
              <Music2 className="size-3" aria-hidden /> {s.soundCount} sounds
            </Badge>
          )}
        </div>
      </div>
    </Link>
  );
}
