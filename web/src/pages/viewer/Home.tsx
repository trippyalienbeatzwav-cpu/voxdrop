import { useEffect, type ComponentType, type SVGProps } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CalendarCheck, ChevronRight, Clapperboard, ListMusic, Mic, PartyPopper, Radio, Star } from 'lucide-react';
import { get, post, qs } from '../../lib/api';
import { cx, fmtPoints } from '../../lib/format';
import type { Message, Page, Streamer } from '../../lib/types';
import { useConfig, useMe } from '../../lib/session';
import { useRealtime } from '../../lib/realtime';
import { Avatar, EmptyState, LiveBadge, Skeleton, SkeletonList, Tooltip } from '../../components/ui/Feedback';
import { Button, ButtonLink } from '../../components/ui/Button';
import { MessageCard } from '../../components/shared';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { StreamerModeButton } from '../../components/layout/AppShell';
import { BellAlert, BuddyHeart, CoinBuddy, DragonMic, GamerPad, HeroScene, PiggyHeart, QueueDJ, RaccoonStreamer, ShieldGuard, StudioCam } from '../../components/art/Mascots';

type Art = ComponentType<SVGProps<SVGSVGElement>>;
interface Card {
  key: string;
  title: string;
  body: string;
  to: string;
  art: Art;
  tint: string;
  featured?: string;
}

/** Account-aware cards. Viewer vs streamer comes from the real /api/me channels (one account, optional streamer profile). */
function cardsFor(isStreamer: boolean, isModerator: boolean): Card[] {
  const voice: Card = { key: 'voice', title: 'Voice messages', body: 'Send a voice message directly to a streamer.', to: '/voice', art: DragonMic, tint: '#5BC46A' };
  const subs: Card = { key: 'subs', title: 'My subscriptions', body: 'Manage your subscriptions and streamer support.', to: '/subscriptions', art: BuddyHeart, tint: '#8E6CFF' };
  const donations: Card = { key: 'donations', title: 'Donations', body: 'Support streamers and track your donations.', to: '/donations', art: PiggyHeart, tint: '#FF8FB5' };
  const mod: Card = { key: 'mod', title: 'Moderation', body: 'Manage your moderation tools and blocked users.', to: '/streamer/moderation', art: ShieldGuard, tint: '#3DA5FF' };
  if (isStreamer)
    return [
      voice,
      subs,
      { key: 'studio', title: 'Streamer dashboard', body: 'Your queue, alerts, sounds and rewards in one studio.', to: '/streamer/dashboard', art: StudioCam, tint: '#FFD43B', featured: 'Your studio' },
      { key: 'queue', title: 'Live queue', body: 'Approve, prioritise and play messages on stream.', to: '/streamer/queue', art: QueueDJ, tint: '#2FD3B4' },
      { key: 'obs', title: 'Alerts / OBS', body: 'Sub, gift-sub and donation alerts and overlay URLs.', to: '/streamer/obs', art: BellAlert, tint: '#FFC928' },
      donations,
    ];
  return [
    voice,
    subs,
    ...(isModerator ? [mod] : []),
    { key: 'streamers', title: 'All streamers', body: 'Discover Kick streamers.', to: '/streamers', art: GamerPad, tint: '#FF7A45' },
    { key: 'become', title: 'Become a streamer', body: 'Connect your Kick channel and unlock your streamer dashboard.', to: '/become-streamer', art: RaccoonStreamer, tint: '#FFD43B', featured: 'Start here' },
    { key: 'points', title: 'Points & rewards', body: 'Manage your points, rewards and activity.', to: '/points', art: CoinBuddy, tint: '#FFC928' },
    donations,
  ];
}

function QuickCard({ c }: { c: Card }) {
  const Art = c.art;
  return (
    <Link
      to={c.to}
      className={cx(
        'group relative isolate flex min-h-[132px] flex-col justify-between rounded-[22px] border p-5 pr-[40%] transition-[transform,border-color,background-color,box-shadow] duration-200 ease-out hover:-translate-y-1 focus-visible:-translate-y-1',
        c.featured ? 'border-volt/45 bg-[#0d0d08]/95 hover:border-volt hover:shadow-[0_18px_44px_-18px_rgb(255_212_59/0.55)]' : 'border-white/[0.07] bg-[#050707]/92 hover:border-volt/50 hover:bg-[#0b0e0e]/95 hover:shadow-[0_18px_44px_-20px_rgb(255_212_59/0.35)]',
      )}
      style={{ backgroundImage: `radial-gradient(120% 140% at 100% 100%, ${c.tint}24, transparent 55%)` }}
    >
      {c.featured && <span className="relative z-10 mb-1 w-fit rounded-full bg-volt px-2 py-0.5 font-display text-[11px] font-extrabold uppercase tracking-wider text-on-volt">{c.featured}</span>}
      <div>
        <h3 className="font-esports relative z-10 text-[clamp(21px,2.4vw,28px)] leading-[1.05] text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]">{c.title}</h3>
        <p className="relative z-10 mt-1 text-sm leading-snug text-white/70">{c.body}</p>
      </div>
      <ChevronRight className="mt-3 size-5 text-white/50 transition-[transform,color] duration-200 group-hover:translate-x-1 group-hover:text-volt" aria-hidden />
      {/* Illustration sits on the right and may overlap the top edge — never under the text column. */}
      <Art className="pointer-events-none absolute -top-9 right-1 -z-10 size-[128px] origin-bottom sm:size-[150px] xl:size-[160px] drop-shadow-[0_12px_18px_rgb(0_0_0/0.6)] transition-transform duration-200 ease-out group-hover:scale-[1.06] sm:size-[160px]" />
    </Link>
  );
}

function Particles() {
  // Decorative drifting sparks; disabled automatically by the reduced-motion rules.
  const dots = [8, 18, 27, 41, 55, 63, 72, 86, 93];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {dots.map((x, i) => (
        <span key={x} className="absolute bottom-0 size-1.5 rounded-full bg-volt/80 shadow-[0_0_10px_2px_rgb(255_212_59/0.6)]" style={{ left: `${x}%`, animation: `drift ${9 + (i % 4) * 2.5}s linear ${i * 1.3}s infinite both` }} />
      ))}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="space-y-8 pt-2" aria-busy="true" aria-label="Loading your home">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-10 w-64" />
      </div>
      <Skeleton className="h-[280px] rounded-[24px]" />
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-x-4 gap-y-12 pt-6 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[132px] rounded-[22px]" />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const meQ = useMe();
  const me = meQ.data;
  const cfg = useConfig().data;
  const rt = useRealtime();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const live = useQuery({ queryKey: ['streamers', 'home'], queryFn: () => get<{ items: Streamer[] }>(`/api/streamers${qs({ sort: 'live', limit: 8 })}`) });
  const recent = useQuery({ queryKey: ['my-messages', 'home'], queryFn: () => get<Page<Message>>('/api/messages?limit=4') });
  const daily = useMutation({
    mutationFn: () => post<{ awarded: number }>('/api/me/daily-bonus'),
    onSuccess: (r) => {
      toast({ title: `+${r.awarded} points claimed`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });
  const welcome = params.get('welcome') === '1';
  useEffect(() => {
    if (welcome) setTimeout(() => setParams({}, { replace: true }), 8000);
  }, [welcome, setParams]);

  if (meQ.isLoading || !me?.user) return <HomeSkeleton />;
  const u = me.user;
  const isStreamer = (me.channels ?? []).some((c) => c.access === 'owner');
  const isModerator = (me.channels ?? []).some((c) => c.access === 'moderator');
  const cards = cardsFor(isStreamer, isModerator);
  const online = rt.status === 'open';

  return (
    <div className="space-y-8">
      {welcome && (
        <div className="card-raised flex animate-rise items-center gap-4 border-volt/30 p-5">
          <PartyPopper className="size-8 shrink-0 text-volt" aria-hidden />
          <div>
            <p className="font-semibold">Welcome to VoxDrop, {u.displayName}!</p>
            <p className="text-sm text-muted">Find a streamer, record a voice note and hear it live. Any Kick sub rewards you had waiting were added to your balance.</p>
          </div>
        </div>
      )}

      {/* Identity */}
      <section aria-label="Your profile" className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="relative rounded-full p-[3px]" style={{ background: 'conic-gradient(from 200deg, #FFD43B, #ffb300, #FFD43B)' }}>
          <Avatar src={u.avatarUrl} name={u.displayName} size={64} className="ring-4 ring-[#050908]" />
        </div>
        <div className="min-w-0">
          <h1 className="font-esports break-words text-[40px] leading-none text-volt sm:text-5xl">{u.displayName}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-white/80">
              <span className={cx('size-2 rounded-full', online ? 'bg-success' : 'bg-amber')} aria-hidden />
              {online ? 'Online' : 'Connecting…'}
            </span>
            <Tooltip label="Your Points Balance">
              <Link to="/points" className="flex items-center gap-1.5 font-medium text-white/80 hover:text-white" aria-label={`Your points balance: ${fmtPoints(me.points ?? 0)} points`}>
                <Star className="size-4 fill-volt text-volt" aria-hidden />
                <span className="num">{fmtPoints(me.points ?? 0)}</span> points
              </Link>
            </Tooltip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {u.dailyBonusAvailable && (
            <Button size="sm" variant="secondary" icon={<CalendarCheck className="size-4" />} loading={daily.isPending} onClick={() => daily.mutate()}>
              Claim +{cfg?.dailyBonusPoints ?? 25} daily
            </Button>
          )}
          {isStreamer ? (
            <StreamerModeButton />
          ) : (
            (me.channels?.length ?? 0) > 0 && (
              <ButtonLink to="/streamer/dashboard" size="sm" icon={<Clapperboard className="size-4" />}>
                Switch to Streamer
              </ButtonLink>
            )
          )}
        </div>
      </section>

      {/* Hero */}
      <section aria-labelledby="hero-h" className="relative isolate overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#07100e]/90">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(90%_120%_at_85%_40%,rgb(255_212_59/0.16),transparent_55%),radial-gradient(70%_90%_at_0%_100%,rgb(47_211_180/0.12),transparent_60%)]" aria-hidden />
        <div className="absolute inset-0 -z-10 opacity-[0.07] [background-image:radial-gradient(#fff_1px,transparent_1px)] [background-size:22px_22px]" aria-hidden />
        <Particles />
        <div className="flex flex-col-reverse items-stretch md:min-h-[280px] md:flex-row md:items-center">
          <div className="relative z-10 flex-1 p-6 sm:p-8 md:py-10 md:pl-10 md:pr-4">
            <span className="rounded-full bg-volt px-2.5 py-0.5 font-display text-xs font-extrabold uppercase tracking-wider text-on-volt">New</span>
            <h2 id="hero-h" className="font-esports mt-3 text-[40px] leading-[0.95] text-white sm:text-[52px]">
              Your stream.
              <br />
              <span className="text-volt">Your community.</span>
            </h2>
            <p className="mt-3 max-w-md text-[15px] text-white/75">Send voice messages, sounds and support directly to your favorite Kick streamers.</p>
            <Link to="/streamers" className="group mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-volt px-5 font-display text-base font-extrabold uppercase tracking-wide text-on-volt shadow-[0_10px_30px_-10px_rgb(255_212_59/0.8)] transition-transform duration-200 hover:-translate-y-0.5">
              Explore streamers <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
            </Link>
          </div>
          <div className="relative h-48 shrink-0 sm:h-56 md:h-[280px] md:w-[46%]">
            <HeroScene className="absolute inset-0 h-full w-full" />
          </div>
        </div>
      </section>

      {/* Quick access */}
      <section aria-labelledby="qa-h">
        <h2 id="qa-h" className="font-esports text-[32px] leading-none text-white">
          Quick access
        </h2>
        <ul className="mt-12 grid gap-x-4 gap-y-12 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <li key={c.key}>
              <QuickCard c={c} />
            </li>
          ))}
        </ul>
      </section>

      {/* Existing activity (unchanged data sources) */}
      <section aria-labelledby="live-h" className="pt-2">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="live-h" className="font-esports flex items-center gap-2 text-2xl text-white">
            <Radio className="size-5 text-magenta" aria-hidden /> Streamers
          </h2>
          <Link to="/streamers" className="text-sm font-semibold text-volt hover:underline">
            See all
          </Link>
        </div>
        {live.isLoading ? (
          <Skeleton className="h-20 rounded-2xl" />
        ) : (
          <ul className="flex gap-3 overflow-x-auto pb-2">
            {live.data?.items.map((s) => (
              <li key={s.id} className="shrink-0">
                <Link to={`/streamer/${s.slug}`} className="card flex w-56 items-center gap-3 p-3 transition-colors hover:border-volt/40">
                  <Avatar src={s.avatarUrl} name={s.displayName} size={44} ring={s.isLive ? 'var(--color-magenta)' : undefined} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{s.displayName}</p>
                    <LiveBadge live={s.isLive} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="recent-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-h" className="font-esports flex items-center gap-2 text-2xl text-white">
            <ListMusic className="size-5 text-volt" aria-hidden /> Your recent messages
          </h2>
          <Link to="/messages" className="text-sm font-semibold text-volt hover:underline">
            View all
          </Link>
        </div>
        {recent.isLoading ? (
          <SkeletonList rows={2} />
        ) : !recent.data?.items.length ? (
          <EmptyState icon={<Mic />} title="You haven’t sent anything yet" body="Pick a streamer and record your first voice message." action={<ButtonLink to="/streamers" variant="primary">Find a streamer</ButtonLink>} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {recent.data.items.map((m) => (
              <MessageCard key={m.id} m={m} showStreamer dense />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
