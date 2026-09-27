import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, Gift, Info, Sparkles, Star } from 'lucide-react';
import { get } from '../../lib/api';
import { fmtPoints, fmtRelative } from '../../lib/format';
import { Avatar, EmptyState, ErrorState, LiveBadge, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Button, ButtonLink } from '../../components/ui/Button';
import { GiftSubDialog } from '../../components/layout/AppShell';
import { BuddyHeart } from '../../components/art/Mascots';

interface Row {
  streamer_id: string;
  slug: string;
  display_name: string;
  avatar_url: string | null;
  is_live: boolean;
  months: number;
  last_sub_at: string | null;
  gifts: number;
  last_gift_at: string | null;
  points_earned: number;
}

/**
 * "My Plan": the Kick subscriptions and gift subs this account made, as
 * recorded from Kick's verified webhooks. Subscriptions themselves are bought
 * on Kick — VoxDrop only rewards them with points.
 */
export default function Subscriptions() {
  const q = useQuery({ queryKey: ['my-subscriptions'], queryFn: () => get<{ items: Row[]; giftedToYou: number }>('/api/me/subscriptions') });
  const [gift, setGift] = useState(false);
  const totalPoints = q.data?.items.reduce((s, r) => s + r.points_earned, 0) ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="My plan"
        title="Subscriptions & support"
        subtitle="Channels you’ve subscribed to or gifted subs on Kick, and the points they earned you here."
        actions={
          <Button variant="primary" icon={<Gift className="size-4" />} onClick={() => setGift(true)}>
            Gift a subscription
          </Button>
        }
      />
      <div className="card flex items-start gap-3 p-4 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-cyan" aria-hidden />
        <p>
          Subscriptions are purchased and managed on Kick. When a channel uses VoxDrop, Kick tells us about your sub or gift (verified webhook) and we add the streamer’s points reward to your balance. Points have no cash value.
        </p>
      </div>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <SkeletonList rows={3} />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={<BuddyHeart className="size-24" />}
          title="No subscriptions recorded yet"
          body={q.data?.giftedToYou ? `You’ve received ${q.data.giftedToYou} gifted sub(s). Subscribe to a channel on Kick to see it here.` : 'Subscribe to or gift subs on a VoxDrop channel on Kick and it will show up here with the points you earned.'}
          action={<ButtonLink to="/streamers" variant="primary">Find streamers</ButtonLink>}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Channels supported" value={String(q.data.items.length)} />
            <Stat label="Gift subs given" value={fmtPoints(q.data.items.reduce((s, r) => s + r.gifts, 0))} />
            <Stat label="Points earned from subs" value={fmtPoints(totalPoints)} star />
          </div>
          <ul className="grid gap-3 lg:grid-cols-2">
            {q.data.items.map((r) => (
              <li key={r.streamer_id} className="card flex flex-wrap items-center gap-4 p-4">
                <Avatar src={r.avatar_url} name={r.display_name} size={48} ring={r.is_live ? 'var(--color-magenta)' : undefined} />
                <div className="min-w-0 flex-1">
                  <Link to={`/streamer/${r.slug}`} className="font-esports block truncate text-xl text-white hover:text-volt">
                    {r.display_name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <LiveBadge live={r.is_live} />
                    {r.months > 0 && (
                      <span className="flex items-center gap-1">
                        <Sparkles className="size-3 text-volt" aria-hidden /> Subscribed · {r.months} month{r.months === 1 ? '' : 's'} · {fmtRelative(r.last_sub_at)}
                      </span>
                    )}
                    {r.gifts > 0 && (
                      <span className="flex items-center gap-1">
                        <Gift className="size-3 text-violet" aria-hidden /> {r.gifts} gifted · {fmtRelative(r.last_gift_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-sm font-semibold">
                    <Star className="size-4 fill-volt text-volt" aria-hidden /> <span className="num">{fmtPoints(r.points_earned)}</span>
                    <span className="sr-only">points earned</span>
                  </span>
                  <a href={`https://kick.com/${encodeURIComponent(r.slug)}`} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center gap-1 rounded-full border border-white/10 px-3 text-sm font-medium text-white/80 hover:border-volt/50 hover:text-white">
                    Manage on Kick <ExternalLink className="size-3.5" aria-hidden />
                    <span className="sr-only">(opens kick.com in a new tab)</span>
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <GiftSubDialog open={gift} onClose={() => setGift(false)} />
    </div>
  );
}

function Stat({ label, value, star }: { label: string; value: string; star?: boolean }) {
  return (
    <div className="card p-4">
      <p className="label-caps">{label}</p>
      <p className="font-esports mt-1 flex items-center gap-2 text-3xl text-white">
        {star && <Star className="size-6 fill-volt text-volt" aria-hidden />}
        <span className="num font-sans text-2xl font-bold">{value}</span>
      </p>
    </div>
  );
}
