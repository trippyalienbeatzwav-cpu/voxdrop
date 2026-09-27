import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AudioLines, Coins, Gift, HandCoins, MessageSquare, Pause, Play, PlayCircle, ShieldAlert, Sparkles, Users } from 'lucide-react';
import { get } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtMoney, fmtPoints, fmtRelative } from '../../lib/format';
import type { QueueState } from '../../lib/types';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, Skeleton, StatCard } from '../../components/ui/Feedback';
import { Button, ButtonLink } from '../../components/ui/Button';
import { RankBars, Sparkline } from '../../components/charts';
import { TypeBadge } from '../../components/shared';
import { useConfig } from '../../lib/session';
import { useStaffActions } from './staff';

interface Dash {
  cards: {
    todayMessages: number;
    todayDonations: Array<{ currency: string; totalCents: number; count: number }>;
    pointsSpentToday: number;
    subscriptionsToday: number;
    giftSubsToday: number;
    queueLength: number;
    pendingReview: number;
    activeUsers24h: number;
  };
  recentDonations: Array<{ id: string; amount_cents: number; currency: string; message: string; status: string; is_anonymous: boolean; created_at: string; display_name: string; avatar_url: string | null }>;
  topSupporters: Array<{ id: string; display_name: string; avatar_url: string | null; points: number; messages: number; donated_cents: number }>;
  pointsActivity: Array<{ day: string; spent: number; messages: number }>;
}

export default function StreamerDashboard() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const isOwner = channel?.access === 'owner';
  const cfg = useConfig().data;
  const a = useStaffActions();
  const d = useQuery({ queryKey: ['channel-dashboard', sid], enabled: !!sid, queryFn: () => get<Dash>(`/api/channels/${sid}/dashboard`), refetchInterval: 30_000 });
  const q = useQuery({ queryKey: ['queue', sid], enabled: !!sid, queryFn: () => get<QueueState>(`/api/channels/${sid}/queue`) });
  if (!sid) return null;
  if (d.error) return <ErrorState error={d.error} onRetry={() => d.refetch()} />;
  const c = d.data?.cards;
  const donationsToday = c?.todayDonations.reduce((s, x) => s + x.totalCents, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${channel!.display_name}’s studio`}
        subtitle={channel!.access === 'owner' ? 'Everything happening on your channel, live.' : 'You are moderating this channel.'}
        actions={
          <>
            <ButtonLink to="/streamer/queue" variant="primary" icon={<AudioLines className="size-4" />}>
              Open live queue
            </ButtonLink>
            <ButtonLink to={`/streamer/${channel!.slug}`}>View public page</ButtonLink>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {!c ? (
          Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
        ) : (
          <>
            <StatCard label="Messages today" value={c.todayMessages} icon={<MessageSquare />} tone="cyan" />
            <StatCard label="Donations today" value={isOwner ? fmtMoney(donationsToday, cfg?.currency) : '—'} icon={<HandCoins />} tone="magenta" hint={isOwner ? `${c.todayDonations.reduce((s, x) => s + x.count, 0)} donations` : 'Owner only'} />
            <StatCard label="Points spent" value={fmtPoints(c.pointsSpentToday)} icon={<Coins />} />
            <StatCard label="Subscriptions" value={c.subscriptionsToday} icon={<Sparkles />} tone="violet" hint="today" />
            <StatCard label="Gift subs" value={c.giftSubsToday} icon={<Gift />} tone="magenta" hint="today" />
            <StatCard label="Queue" value={c.queueLength} icon={<AudioLines />} tone="amber" hint={`${c.pendingReview} awaiting review`} />
            <StatCard label="Active users" value={c.activeUsers24h} icon={<Users />} tone="cyan" hint="last 24h" />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="card p-5 xl:col-span-2" aria-labelledby="lq-h">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="lq-h" className="text-lg font-semibold">
              Live queue
            </h2>
            <div className="flex gap-2">
              {q.data && (
                <Button size="sm" icon={q.data.paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={() => a.pause.mutate(!q.data!.paused)}>
                  {q.data.paused ? 'Resume' : 'Pause'}
                </Button>
              )}
              <Button size="sm" variant="primary" icon={<PlayCircle className="size-4" />} onClick={() => a.playNext.mutate(false)} disabled={!q.data?.items.length || !!q.data?.nowPlaying}>
                Play next
              </Button>
            </div>
          </div>
          {q.isLoading ? (
            <Skeleton className="h-40" />
          ) : !q.data?.nowPlaying && !q.data?.items.length ? (
            <EmptyState icon={<AudioLines />} title="Queue is empty" className="py-8" />
          ) : (
            <ol className="space-y-2">
              {q.data?.nowPlaying && (
                <li className="flex items-center gap-3 rounded-xl border border-volt/30 bg-volt/[0.05] p-3">
                  <Badge tone="volt" dot>
                    On air
                  </Badge>
                  <Avatar src={q.data.nowPlaying.sender.avatarUrl} name={q.data.nowPlaying.sender.displayName} size={32} />
                  <span className="truncate font-medium">{q.data.nowPlaying.sender.displayName}</span>
                  <TypeBadge type={q.data.nowPlaying.type} />
                </li>
              )}
              {q.data?.items.slice(0, 5).map((it, i) => (
                <li key={it.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                  <span className="num w-5 text-sm text-subtle">{i + 1}</span>
                  <Avatar src={it.sender.avatarUrl} name={it.sender.displayName} size={32} />
                  <span className="min-w-0 flex-1 truncate font-medium">{it.sender.displayName}</span>
                  <TypeBadge type={it.type} />
                  <span className="num hidden text-sm text-volt sm:inline">{fmtPoints(it.pointsSpent)}</span>
                </li>
              ))}
            </ol>
          )}
          {!!c?.pendingReview && (
            <Link to="/streamer/moderation" className="mt-4 flex items-center gap-2 rounded-xl border border-amber/30 bg-amber/10 p-3 text-sm font-medium text-amber">
              <ShieldAlert className="size-4" aria-hidden /> {c.pendingReview} message{c.pendingReview === 1 ? '' : 's'} waiting for review →
            </Link>
          )}
        </section>

        <section className="card p-5" aria-labelledby="pa-h">
          <h2 id="pa-h" className="text-lg font-semibold">
            Points activity
          </h2>
          <p className="text-sm text-subtle">Points spent on your channel, last 7 days</p>
          {d.data ? (
            <>
              <Sparkline values={d.data.pointsActivity.map((p) => p.spent)} height={80} className="mt-4" />
              <div className="mt-2 flex justify-between text-xs text-subtle">
                <span>{d.data.pointsActivity[0]?.day.slice(5)}</span>
                <span className="num font-semibold text-fg">{fmtPoints(d.data.pointsActivity.reduce((s, p) => s + p.spent, 0))} pts</span>
                <span>today</span>
              </div>
            </>
          ) : (
            <Skeleton className="mt-4 h-24" />
          )}
        </section>

        <section className="card p-5" aria-labelledby="rd-h">
          <h2 id="rd-h" className="mb-4 text-lg font-semibold">
            Recent donations
          </h2>
          {!isOwner ? (
            <p className="text-sm text-muted">Donation details are visible to the channel owner.</p>
          ) : !d.data?.recentDonations.length ? (
            <p className="text-sm text-muted">No donations yet.</p>
          ) : (
            <ul className="space-y-3">
              {d.data.recentDonations.map((x) => (
                <li key={x.id} className="flex items-start gap-3">
                  <Avatar src={x.is_anonymous ? null : x.avatar_url} name={x.is_anonymous ? 'Anonymous' : x.display_name} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{x.is_anonymous ? 'Anonymous' : x.display_name}</p>
                    {x.message && <p className="line-clamp-2 text-xs text-muted">{x.message}</p>}
                    <p className="text-[11px] text-subtle">{fmtRelative(x.created_at)}</p>
                  </div>
                  <span className={`num text-sm font-semibold ${x.status === 'REFUNDED' ? 'text-subtle line-through' : 'text-magenta'}`}>{fmtMoney(x.amount_cents, x.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5" aria-labelledby="ts-h">
          <h2 id="ts-h" className="mb-4 text-lg font-semibold">
            Top supporters <span className="text-sm font-normal text-subtle">· 30 days</span>
          </h2>
          {d.data?.topSupporters.length ? (
            <RankBars rows={d.data.topSupporters.map((s) => ({ label: s.display_name, value: s.points, sub: s.donated_cents && isOwner ? fmtMoney(s.donated_cents, cfg?.currency) : `${s.messages} msgs` }))} format={(n) => fmtPoints(n)} />
          ) : (
            <p className="text-sm text-muted">No supporters yet.</p>
          )}
        </section>

        <section className="card p-5" aria-labelledby="qc-h">
          <h2 id="qc-h" className="mb-4 text-lg font-semibold">
            Quick controls
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <ButtonLink to="/streamer/moderation" icon={<ShieldAlert className="size-4" />}>
              Review
            </ButtonLink>
            <ButtonLink to="/streamer/soundboard" icon={<Sparkles className="size-4" />}>
              Soundboard
            </ButtonLink>
            {isOwner && (
              <>
                <ButtonLink to="/streamer/settings">Pricing & limits</ButtonLink>
                <ButtonLink to="/streamer/integrations">OBS overlay</ButtonLink>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
