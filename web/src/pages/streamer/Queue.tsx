import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, ArrowUpToLine, AudioLines, Ban, Check, Clock, GripVertical, MicOff, MonitorOff, MonitorPlay, MoreHorizontal, Pause, Play,
  Megaphone, PlayCircle, ShieldAlert, SkipForward, Trash2, User, Volume2, VolumeX, X, Pin, RotateCcw, Hourglass, Settings2,
} from 'lucide-react';
import { get, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtDuration, fmtRelative, fmtWait } from '../../lib/format';
import type { Message, Page, QueueItem, QueueState } from '../../lib/types';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, Points, Skeleton } from '../../components/ui/Feedback';
import { Button, IconButton } from '../../components/ui/Button';
import { Menu } from '../../components/ui/Menu';
import { TypeBadge } from '../../components/shared';
import { AudioPreview, Waveform } from '../../components/audio/Waveform';
import { useErrorToast } from '../../components/ui/Toast';
import { useStaffActions } from './staff';
import { AnnouncementQuickControls, useItemAnnouncementPreview } from './AnnouncementControls';
import { TierBadge } from '../../components/priority';

type Tiers = QueueState['priority']['tiers'];

export default function Queue() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const a = useStaffActions();
  const qc = useQueryClient();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['queue', sid], enabled: !!sid, queryFn: () => get<QueueState>(`/api/channels/${sid}/queue`), refetchInterval: 20_000 });
  const pending = useQuery({ queryKey: ['channel-messages', sid, 'PENDING', 'strip'], enabled: !!sid, queryFn: () => get<Page<Message> & { counts: Record<string, number> }>(`/api/channels/${sid}/messages?status=PENDING&limit=5`) });

  // Local optimistic order while dragging / after moves.
  const [order, setOrder] = useState<QueueItem[]>([]);
  useEffect(() => setOrder(q.data?.items ?? []), [q.data]);
  const [dragId, setDragId] = useState<string | null>(null);

  async function commitOrder(next: QueueItem[]) {
    const prev = order;
    setOrder(next);
    try {
      const r = await post<QueueState>(`/api/channels/${sid}/queue/reorder`, { itemIds: next.map((i) => i.queue!.itemId) });
      qc.setQueryData(['queue', sid], r);
    } catch (err) {
      setOrder(prev);
      onError(err);
      q.refetch();
    }
  }
  const move = (idx: number, to: number) => {
    if (to < 0 || to >= order.length || to === idx) return;
    const next = [...order];
    const [it] = next.splice(idx, 1);
    next.splice(to, 0, it!);
    void commitOrder(next);
  };

  async function resetOrder() {
    try {
      await post(`/api/channels/${sid}/queue/reset-order`);
      await q.refetch();
    } catch (err) {
      onError(err);
    }
  }

  if (!sid) return null;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const state = q.data;
  const tiers: Tiers = state?.priority?.tiers ?? [];
  const now = state?.nowPlaying;

  return (
    <div>
      <PageHeader
        title="Live queue"
        subtitle="Approved messages play one at a time on your OBS overlay."
        actions={
          state && (
            <>
              <Badge tone={state.overlayConnected ? 'success' : 'amber'} className="h-9 px-3">
                {state.overlayConnected ? <MonitorPlay className="size-4" /> : <MonitorOff className="size-4" />}
                {state.overlayConnected ? 'Overlay connected' : 'Overlay offline'}
              </Badge>
              {order.some((i) => i.pinned) && (
                <Button icon={<RotateCcw className="size-4" />} onClick={() => void resetOrder()}>
                  Automatic order
                </Button>
              )}
              <Button variant={state.paused ? 'primary' : 'secondary'} icon={state.paused ? <Play className="size-4" /> : <Pause className="size-4" />} loading={a.pause.isPending} onClick={() => a.pause.mutate(!state.paused)}>
                {state.paused ? 'Resume queue' : 'Pause queue'}
              </Button>
            </>
          )
        }
      />

      {state && !state.overlayConnected && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber/30 bg-amber/10 p-4 text-sm text-amber">
          <MonitorOff className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">Auto-play waits until your OBS overlay is open. You can still play items manually and preview them here.</span>
          <Link to="/streamer/obs" className="font-semibold underline">
            Set up overlay
          </Link>
        </div>
      )}

      <AnnouncementQuickControls />

      {/* Now playing */}
      <section aria-labelledby="np-h" className="card-raised mb-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
          <h2 id="np-h" className="flex items-center gap-2 text-sm font-semibold">
            <AudioLines className="size-4 text-volt" aria-hidden /> Now playing
          </h2>
          {state && (
            <span className="text-xs text-subtle">
              {state.items.length} queued · {fmtDuration(state.totalWaitMs)} total · auto-play {state.autoPlay ? (state.paused ? 'paused' : `on${state.autoPlayDelayMs ? ` (${state.autoPlayDelayMs / 1000}s gap)` : ''}`) : 'off'}
              {state.priority?.enabled ? ' · priority on' : ' · first come, first served'}{' '}
              <Link to="/streamer/priority" className="ml-1 inline-flex items-center gap-1 font-medium text-volt hover:underline">
                <Settings2 className="size-3" aria-hidden /> Priority settings
              </Link>
            </span>
          )}
        </div>
        {q.isLoading ? (
          <Skeleton className="m-5 h-24" />
        ) : now ? (
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
            <Avatar src={now.sender.avatarUrl} name={now.sender.displayName} size={64} ring="var(--color-volt)" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">{now.sender.displayName}</span>
                <TypeBadge type={now.type} />
                <PhaseBadge phase={now.queue?.phase ?? null} />
                {now.priorityTier && now.priorityTier !== 'NORMAL' && <TierFor tier={now.priorityTier} tiers={tiers} />}
                {now.pointsSpent > 0 && <Points value={now.pointsSpent} />}
              </div>
              {now.queue?.announcement.text && (
                <p className={cx('flex items-center gap-2 text-sm', now.queue.phase === 'ANNOUNCING' ? 'text-volt' : 'text-muted')}>
                  <Megaphone className="size-4 shrink-0" aria-hidden /> “{now.queue.announcement.text}”
                  {now.queue.announcement.status === 'FAILED' && <Badge tone="danger">announcement failed</Badge>}
                </p>
              )}
              {now.sound && <p className="font-medium">{now.sound.name}</p>}
              {now.text && <p className="text-fg/90">{now.text}</p>}
              {now.audio ? <AudioPreview audioId={now.audio.id} peaks={now.audio.waveform} durationMs={now.audio.durationMs} label="now playing (preview locally)" /> : <Waveform peaks={[]} height={24} />}
            </div>
            <div className="flex gap-2 md:flex-col">
              <Button variant="danger" icon={<SkipForward className="size-4" />} onClick={() => a.skip.mutate(now.queue!.itemId)} loading={a.skip.isPending}>
                Skip
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-muted">{state?.items.length ? 'Nothing is playing.' : 'The queue is empty — approved messages show up here.'}</p>
            {!!state?.items.length && (
              <Button variant="primary" icon={<PlayCircle className="size-4" />} loading={a.playNext.isPending} onClick={() => a.playNext.mutate(false)}>
                Play next
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Pending review strip */}
      {!!pending.data?.items.length && (
        <section aria-labelledby="pend-h" className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="pend-h" className="flex items-center gap-2 text-sm font-semibold text-amber">
              <ShieldAlert className="size-4" aria-hidden /> Waiting for review ({pending.data.counts.PENDING})
            </h2>
            <Link to="/streamer/moderation" className="text-sm font-medium text-volt hover:underline">
              Open moderation
            </Link>
          </div>
          <ul className="grid gap-2 md:grid-cols-2">
            {pending.data.items.map((m) => (
              <li key={m.id} className="card flex min-w-0 items-center gap-3 p-3">
                <Avatar src={m.sender.avatarUrl} name={m.sender.displayName} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.sender.displayName}</p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <TypeBadge type={m.type} />
                    <span className="truncate text-xs text-subtle">{m.text || (m.audio ? fmtDuration(m.audio.durationMs) : '')}</span>
                  </div>
                </div>
                <IconButton label={`Approve message from ${m.sender.displayName}`} tone="volt" onClick={() => a.approve.mutate(m.id)}>
                  <Check className="size-4" />
                </IconButton>
                <IconButton label={`Reject message from ${m.sender.displayName}`} tone="danger" onClick={() => a.reject.mutate({ id: m.id })}>
                  <X className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Queue */}
      <section aria-labelledby="q-h">
        <h2 id="q-h" className="mb-3 text-lg font-semibold">
          Up next
        </h2>
        {q.isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : !order.length ? (
          <EmptyState icon={<AudioLines />} title="No one in line" body="When you approve messages (or viewers play sounds), they line up here." />
        ) : (
          <>
          <p id="reorder-help" className="sr-only">
            Drag items by the handle, or use the move up and move down buttons to reorder.
          </p>
          <ol className="space-y-3" aria-describedby="reorder-help">
            {order.map((it, idx) => (
              <QueueCard
                key={it.id}
                it={it}
                idx={idx}
                count={order.length}
                dragging={dragId === it.id}
                onDragStart={() => setDragId(it.id)}
                onDragEnd={() => setDragId(null)}
                onDropOn={(targetIdx) => {
                  const from = order.findIndex((o) => o.id === dragId);
                  setDragId(null);
                  if (from >= 0) move(from, targetIdx);
                }}
                onMove={(to) => move(idx, to)}
                actions={a}
                tiers={tiers}
                priorityOn={!!state?.priority?.enabled}
              />
            ))}
          </ol>
          </>
        )}
      </section>
    </div>
  );
}

function QueueCard({
  it,
  idx,
  count,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onMove,
  actions: a,
  tiers,
  priorityOn,
}: {
  it: QueueItem;
  idx: number;
  count: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: (idx: number) => void;
  onMove: (to: number) => void;
  actions: ReturnType<typeof useStaffActions>;
  tiers: Tiers;
  priorityOn: boolean;
}) {
  const tierRow = tiers.find((t) => t.tier === it.priorityTier);
  const accent = it.priorityTier && it.priorityTier !== 'NORMAL' ? tierRow?.color : undefined;
  const [over, setOver] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const annPreview = useItemAnnouncementPreview(a.sid);
  const menuItems = [
    { label: 'Play now', icon: <Play />, onSelect: () => a.playNow.mutate(it.id) },
    { label: 'Move to top', icon: <ArrowUpToLine />, onSelect: () => onMove(0), disabled: idx === 0 },
    { label: 'Move up', icon: <ArrowUp />, onSelect: () => onMove(idx - 1), disabled: idx === 0 },
    { label: 'Move down', icon: <ArrowDown />, onSelect: () => onMove(idx + 1), disabled: idx === count - 1 },
    'divider' as const,
    { label: 'Skip (remove & refund)', icon: <SkipForward />, onSelect: () => a.skip.mutate(it.queue!.itemId) },
    { label: 'Reject', icon: <X />, onSelect: () => a.reject.mutate({ id: it.id }), tone: 'danger' as const },
    { label: 'Mute user 10 min', icon: <MicOff />, onSelect: () => a.confirmMute(it), tone: 'danger' as const, disabled: !it.sender.id },
    { label: 'Ban user', icon: <Ban />, onSelect: () => a.confirmBan(it), tone: 'danger' as const, disabled: !it.sender.id },
    { label: 'Delete', icon: <Trash2 />, onSelect: () => a.confirmDelete(it.id), tone: 'danger' as const },
  ];
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropOn(idx);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      className={cx(
        'card flex gap-3 p-4 transition-[opacity,border-color,box-shadow] sm:gap-4',
        dragging && 'opacity-40',
        over && 'border-volt shadow-[0_0_0_1px_rgb(255_212_59/0.4)]',
      )}
      style={accent ? { borderLeft: `3px solid ${accent}`, backgroundImage: `linear-gradient(90deg, ${accent}0f, transparent 45%)` } : undefined}
    >
      <div className="flex flex-col items-center gap-1">
        <span className="num text-sm font-semibold text-subtle" aria-label={`Position ${idx + 1}`}>
          {idx + 1}
        </span>
        <span className="hidden cursor-grab text-subtle active:cursor-grabbing sm:block" aria-hidden>
          <GripVertical className="size-5" />
        </span>
        <IconButton label="Move up" size="sm" onClick={() => onMove(idx - 1)} disabled={idx === 0}>
          <ArrowUp className="size-4" />
        </IconButton>
        <IconButton label="Move down" size="sm" onClick={() => onMove(idx + 1)} disabled={idx === count - 1}>
          <ArrowDown className="size-4" />
        </IconButton>
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex flex-wrap items-start gap-3">
          <Avatar src={it.sender.avatarUrl} name={it.sender.displayName} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{it.sender.displayName}</span>
              <TypeBadge type={it.type} />
              <AnnouncementBadge it={it} />
              {it.priorityTier && (it.priorityTier !== 'NORMAL' || priorityOn) && <TierFor tier={it.priorityTier} tiers={tiers} />}
              {it.pinned && (
                <Badge>
                  <Pin className="size-3" aria-hidden /> Pinned
                </Badge>
              )}
              {it.priorityScore?.starving && (
                <Badge tone="amber">
                  <Hourglass className="size-3" aria-hidden /> Waited too long — plays next
                </Badge>
              )}
              {it.donation && <Badge tone="magenta">Donation</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-subtle">
              <span className="inline-flex items-center gap-1" title="Name spoken in the announcement">
                <User className="size-3" aria-hidden /> {it.viewerName}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" aria-hidden /> {fmtDuration(it.durationMs)}
              </span>
              <time dateTime={it.createdAt}>{fmtRelative(it.createdAt)}</time>
              <span>waiting {fmtWaited(it.waitingSeconds)}</span>
              <span>ETA {fmtWait(it.estimatedWaitMs)}</span>
              {priorityOn && it.priorityScore && !it.pinned && (
                <span className="num" title={`tier ${it.priorityScore.base} + points ${it.priorityScore.points} + waiting ${it.priorityScore.waiting}`}>
                  score {it.priorityScore.score.toFixed(1)}
                </span>
              )}
            </div>
          </div>
          {it.pointsSpent > 0 && <Points value={it.pointsSpent} />}
        </div>
        {it.sound && <p className="text-sm font-medium">{it.sound.name}</p>}
        {it.text && <p className="break-words text-[15px] text-fg/90">{it.text}</p>}
        {it.audio && <AudioPreview audioId={it.audio.id} peaks={it.audio.waveform} durationMs={it.audio.durationMs} label={`message from ${it.sender.displayName}`} />}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="primary" icon={<Play className="size-4" />} onClick={() => a.playNow.mutate(it.id)}>
            Play now
          </Button>
          <Button size="sm" icon={<SkipForward className="size-4" />} onClick={() => a.skip.mutate(it.queue!.itemId)}>
            Skip
          </Button>
          {it.announcementEnabled && (
            <Button size="sm" variant="ghost" icon={<Volume2 className="size-4" />} loading={annPreview.isPending && annPreview.variables === it.queue!.itemId} onClick={() => annPreview.mutate(it.queue!.itemId)}>
              Preview announcement
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => a.reject.mutate({ id: it.id })} className="hidden sm:inline-flex">
            Reject
          </Button>
          <IconButton label={`Mute ${it.sender.displayName}`} size="sm" tone="danger" onClick={() => a.confirmMute(it)} disabled={!it.sender.id} className="hidden sm:inline-flex">
            <MicOff className="size-4" />
          </IconButton>
          <IconButton label={`Ban ${it.sender.displayName}`} size="sm" tone="danger" onClick={() => a.confirmBan(it)} disabled={!it.sender.id} className="hidden sm:inline-flex">
            <Ban className="size-4" />
          </IconButton>
          <div className="ml-auto">
            <Menu
              label="Queue item actions"
              items={menuItems}
              trigger={(p) => (
                <IconButton {...p} label="More actions" size="sm">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              )}
            />
          </div>
        </div>
      </div>
      {ctx && <Menu label="Queue item context menu" items={menuItems} open anchor={ctx} onOpenChange={(v) => !v && setCtx(null)} />}
    </li>
  );
}

function fmtWaited(sec: number) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function TierFor({ tier, tiers }: { tier: NonNullable<QueueItem['priorityTier']>; tiers: Tiers }) {
  const t = tiers.find((x) => x.tier === tier);
  return <TierBadge tier={tier} name={t?.name} color={t?.color} icon={t?.icon} />;
}

function PhaseBadge({ phase }: { phase: string | null }) {
  if (phase === 'ANNOUNCING')
    return (
      <Badge tone="cyan" dot>
        Announcing
      </Badge>
    );
  return (
    <Badge tone="volt" dot>
      {phase === 'PLAYING_MESSAGE' ? 'Playing message' : 'On air'}
    </Badge>
  );
}

/** Shows whether this item gets a spoken name intro before its audio. */
function AnnouncementBadge({ it }: { it: QueueItem }) {
  const st = it.queue?.announcement.status;
  if (!it.announcementEnabled)
    return it.announcementKind ? (
      <Badge>
        <VolumeX className="size-3" aria-hidden /> No announcement
      </Badge>
    ) : null;
  if (st === 'FAILED')
    return (
      <Badge tone="danger">
        <VolumeX className="size-3" aria-hidden /> Announcement failed — plays without
      </Badge>
    );
  return (
    <Badge tone="cyan">
      <Volume2 className="size-3" aria-hidden /> Announcement {st === 'READY' ? 'ready' : 'enabled'}
    </Badge>
  );
}
