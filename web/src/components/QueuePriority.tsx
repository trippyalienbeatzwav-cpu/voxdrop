import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Hourglass, ListOrdered, Lock, ShieldCheck, Users } from 'lucide-react';
import { get, qs } from '../lib/api';
import { cx, fmtPoints, fmtWait } from '../lib/format';
import { TIER_ICONS, TierBadge, type TierKey } from './priority';
import { Skeleton } from './ui/Feedback';

export interface TierOption {
  tier: TierKey;
  name: string;
  color: string;
  icon: string;
  multiplier: number;
  price: number;
  premium: number;
  affordable: boolean;
  cooldownRemaining: number;
  dailyRemaining: number | null;
  available: boolean;
  estimatedPosition: number;
  messagesAhead: number;
  estimatedWaitMs: number;
}
export interface PriorityOptions {
  enabled: boolean;
  defaultTier: TierKey;
  balance: number;
  queueLength: number;
  tiers: TierOption[];
}

/** Server-computed tier prices + where the message would land right now (refreshed while open). */
export function usePriorityOptions(slug: string | undefined, params: { type: string; soundId?: string; bonus?: number }, enabled = true) {
  return useQuery({
    queryKey: ['priority-options', slug, params],
    enabled: !!slug && enabled,
    queryFn: () => get<PriorityOptions>(`/api/streamers/${encodeURIComponent(slug!)}/priority${qs({ type: params.type, soundId: params.soundId, bonus: params.bonus || undefined })}`),
    refetchInterval: 10_000,
    staleTime: 3_000,
  });
}

const posLabel = (o: TierOption) => (o.messagesAhead === 0 ? 'Plays next' : `${o.messagesAhead} ahead of you`);

/**
 * "Playback Priority" radio group. Prices, positions and waits come from the
 * server; the server re-checks everything when the message is created.
 */
export function PriorityPicker({ options, loading, value, onChange }: { options?: PriorityOptions; loading?: boolean; value: TierKey | null; onChange: (t: TierKey) => void }) {
  useEffect(() => {
    if (options && (!value || !options.tiers.some((t) => t.tier === value))) onChange(options.defaultTier);
  }, [options, value, onChange]);
  if (loading) return <Skeleton className="h-40 rounded-xl" />;
  if (!options?.enabled) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ListOrdered className="size-4 text-subtle" aria-hidden /> Playback Priority
      </legend>
      <div role="radiogroup" aria-label="Playback priority" className="grid gap-2 sm:grid-cols-2">
        {options.tiers.map((o) => {
          const selected = value === o.tier;
          const Icon = TIER_ICONS[o.icon] ?? ListOrdered;
          const reason = !o.affordable ? `Need ${fmtPoints(o.price - options.balance)} more` : o.cooldownRemaining > 0 ? `Tier cooldown: ${o.cooldownRemaining}s` : o.dailyRemaining === 0 ? 'Daily limit reached' : null;
          return (
            <button
              key={o.tier}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!o.available}
              onClick={() => onChange(o.tier)}
              className={cx(
                'relative flex min-h-[5.5rem] flex-col gap-1.5 rounded-xl border p-3 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed disabled:opacity-55',
                selected ? 'bg-raised' : 'border-line hover:border-line-strong',
              )}
              style={selected ? { borderColor: o.color, boxShadow: `0 0 0 1px ${o.color}` } : undefined}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-bold" style={{ color: o.color }}>
                  <Icon className="size-4" aria-hidden /> {o.name}
                </span>
                <span className="num text-sm font-semibold">{fmtPoints(o.price)} pts</span>
              </span>
              {reason ? (
                <span className="flex items-center gap-1 text-xs text-amber">
                  <Lock className="size-3" aria-hidden /> {reason}
                </span>
              ) : (
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <Users className="size-3" aria-hidden /> {posLabel(o)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="size-3" aria-hidden /> {fmtWait(o.estimatedWaitMs)}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-subtle">Estimates change as others join. Waiting time also raises every message’s place, so nobody waits forever.</p>
    </fieldset>
  );
}

/** Confirm-dialog copy for a spend, spelling out the priority premium. */
export function spendConfirmCopy(opt: TierOption | undefined, total: number, what: string, streamer: string, manual: boolean) {
  const isPrio = !!opt && opt.tier !== 'NORMAL';
  return {
    title: isPrio ? `Spend ${fmtPoints(total)} points to prioritize this message?` : `Spend ${fmtPoints(total)} points?`,
    body: (
      <div className="space-y-2">
        <p>
          Your {what} goes to {streamer}
          {manual ? ' for review first' : ''}.
        </p>
        {isPrio && opt && (
          <p className="flex flex-wrap items-center gap-2">
            <TierBadge tier={opt.tier} name={opt.name} color={opt.color} icon={opt.icon} /> estimated position <strong className="num text-fg">#{opt.estimatedPosition}</strong> · {fmtWait(opt.estimatedWaitMs)}
          </p>
        )}
        <p className="text-xs">Rejected messages may be refunded, depending on the streamer’s settings. Priority never skips moderation.</p>
      </div>
    ),
    confirmLabel: `Spend ${fmtPoints(total)}`,
  };
}

interface PositionRes {
  position: { position: number; ahead: number; estimatedWaitMs: number; tier: TierKey; queueLength: number } | null;
  state: string;
}

/**
 * Live "N messages ahead of you / Estimated wait" for one of the viewer's own
 * messages. Pushed via queue.position_changed (see realtime.tsx), with a slow
 * poll as a safety net.
 */
export function QueuePositionCard({ messageId, className }: { messageId: string; className?: string }) {
  const q = useQuery({ queryKey: ['msg-position', messageId], queryFn: () => get<PositionRes>(`/api/messages/${messageId}/position`), refetchInterval: 20_000 });
  if (q.isLoading) return <Skeleton className={cx('h-20 rounded-xl', className)} />;
  if (!q.data) return null;
  const { position: p, state } = q.data;
  let icon = <Hourglass className="size-5 text-cyan" aria-hidden />;
  let title: string;
  let sub: string | null = null;
  if (state === 'MODERATION' || state === 'PENDING') {
    icon = <ShieldCheck className="size-5 text-amber" aria-hidden />;
    title = 'Waiting for moderator review';
    sub = 'It joins the queue once approved.';
  } else if (state === 'ANNOUNCING' || state === 'PLAYING' || p?.position === 0) {
    icon = <span className="size-2.5 animate-pulse-dot rounded-full bg-volt" aria-hidden />;
    title = 'Playing on stream now';
  } else if (p) {
    title = p.ahead === 0 ? 'You’re up next' : `${p.ahead} message${p.ahead === 1 ? '' : 's'} ahead of you`;
    sub = `Estimated wait: ${fmtWait(p.estimatedWaitMs)} · position #${p.position} of ${p.queueLength}`;
  } else if (state === 'COMPLETED') {
    icon = <CheckCircle2 className="size-5 text-success" aria-hidden />;
    title = 'Played on stream';
  } else {
    title = state === 'REJECTED' ? 'Not approved' : state === 'SKIPPED' ? 'Skipped' : state.toLowerCase();
  }
  return (
    <div className={cx('flex items-center gap-3 rounded-xl border border-line bg-canvas/60 p-4 text-left', className)} role="status" aria-live="polite">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised ring-1 ring-line">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {p && p.tier !== 'NORMAL' && <TierBadge tier={p.tier} />}
    </div>
  );
}
