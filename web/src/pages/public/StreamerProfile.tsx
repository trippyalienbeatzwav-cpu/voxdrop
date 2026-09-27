import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Ban, ExternalLink, FileAudio, HandCoins, MessageSquare, Mic, Music2, Timer, Zap } from 'lucide-react';
import { get } from '../../lib/api';
import { cx, fmtMoney, fmtPoints } from '../../lib/format';
import type { Sound, Streamer } from '../../lib/types';
import { kickLoginHref, useConfig, useMe } from '../../lib/session';
import { Avatar, Badge, ErrorState, LiveBadge, Skeleton } from '../../components/ui/Feedback';
import { ButtonLink } from '../../components/ui/Button';
import { SoundIcon } from '../../components/shared';

interface ProfileRes {
  streamer: Streamer;
  stats: { queue: number; sounds: number; played: number };
  viewer: { isOwner: boolean; restriction: { kind: string; expiresAt: string | null; reason: string } | null } | null;
}

export default function StreamerProfile() {
  const { username = '' } = useParams();
  const me = useMe().data;
  const cfg = useConfig().data;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['streamer', username], queryFn: () => get<ProfileRes>(`/api/streamers/${encodeURIComponent(username)}`) });
  const sounds = useQuery({ queryKey: ['streamer-sounds', username], queryFn: () => get<{ items: Sound[] }>(`/api/streamers/${encodeURIComponent(username)}/sounds?sort=popular`), enabled: !!q.data });

  // Public live status + queue length updates.
  useEffect(() => {
    if (!q.data) return;
    const es = new EventSource(`/api/streamers/${encodeURIComponent(username)}/events`);
    const refresh = () => qc.invalidateQueries({ queryKey: ['streamer', username] });
    es.addEventListener('streamer.updated', refresh);
    es.addEventListener('queue.updated', refresh);
    return () => es.close();
  }, [q.data, username, qc]);

  if (q.isLoading)
    return (
      <div className={cx(!me?.user && 'mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8')}>
        <Skeleton className="h-56 rounded-2xl" />
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  if (q.error) return <ErrorState className={cx(!me?.user && 'm-6')} error={q.error} onRetry={() => q.refetch()} />;
  const { streamer: s, stats, viewer } = q.data!;
  const f = s.features!;
  const p = s.pricing!;
  const signedIn = !!me?.user;
  const actionHref = (path: string) => (signedIn ? path : kickLoginHref(path));
  const blocked = viewer?.restriction;
  const isOwner = viewer?.isOwner;

  const actions = [
    { key: 'text', on: f.text, icon: MessageSquare, title: 'Send Message', price: p.freeTextPerDay ? `${p.freeTextPerDay} free/day, then ${fmtPoints(p.text)}` : `${fmtPoints(p.text)} pts`, to: `/send/${s.slug}`, tone: 'text-cyan bg-cyan/10' },
    { key: 'voice', on: f.voice || f.mp3, icon: Mic, title: 'Send Voice', price: `${fmtPoints(Math.min(f.voice ? p.voice : Infinity, f.mp3 ? p.mp3 : Infinity))}+ pts`, to: `/voice/${s.slug}`, tone: 'text-volt bg-volt/10' },
    { key: 'sounds', on: f.sounds, icon: Music2, title: 'Sound Library', price: `${stats.sounds} sounds`, to: `/sounds?streamer=${s.slug}`, tone: 'text-magenta bg-magenta/10' },
    { key: 'donate', on: f.donations, icon: HandCoins, title: 'Donate', price: `from ${fmtMoney(s.donations!.minCents, cfg?.currency)}`, to: `/donations?streamer=${s.slug}`, tone: 'text-violet bg-violet/10' },
  ];

  return (
    <div className={cx(!signedIn && 'mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8')}>
      <section className="card relative overflow-hidden">
        <div className="h-36 sm:h-44" style={{ background: s.bannerUrl ? `center/cover url(${s.bannerUrl})` : `radial-gradient(ellipse at 20% 0%, ${s.brandColor}55, transparent 60%), linear-gradient(135deg, ${s.brandColor}22, var(--color-raised))` }} />
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:p-6">
          <div className="-mt-20 sm:-mt-16">
            <Avatar src={s.avatarUrl} name={s.displayName} size={112} ring={s.isLive ? 'var(--color-magenta)' : 'var(--color-line)'} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold">{s.displayName}</h1>
              <LiveBadge live={s.isLive} />
            </div>
            <a href={s.kickUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
              kick.com/{s.slug} <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            {s.isLive && s.liveTitle && <p className="mt-2 text-sm text-fg/90">{s.liveTitle}</p>}
          </div>
          <div className="flex gap-6 text-sm">
            <div>
              <div className="num text-xl font-semibold">{stats.queue}</div>
              <div className="text-subtle">in queue</div>
            </div>
            <div>
              <div className="num text-xl font-semibold">{fmtPoints(stats.played)}</div>
              <div className="text-subtle">played</div>
            </div>
          </div>
        </div>
        {s.bio && <p className="border-t border-line px-5 py-4 text-muted sm:px-6">{s.bio}</p>}
      </section>

      {blocked && (
        <div role="alert" className="mt-4 flex gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <Ban className="size-5 shrink-0" aria-hidden />
          You are {blocked.kind === 'BAN' ? 'banned' : 'muted'} on this channel{blocked.expiresAt ? ` until ${new Date(blocked.expiresAt).toLocaleString()}` : ''}.
        </div>
      )}
      {isOwner && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-volt/25 bg-volt/5 p-4 text-sm">
          This is your channel — viewers see this page.
          <ButtonLink to="/streamer/dashboard" size="sm" variant="primary">
            Open studio
          </ButtonLink>
        </div>
      )}

      <section aria-label="Actions" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((a) => {
          const Icon = a.icon;
          const disabled = !a.on || !!blocked || isOwner;
          const inner = (
            <>
              <span className={cx('flex size-11 items-center justify-center rounded-xl', a.tone)}>
                <Icon className="size-5" aria-hidden />
              </span>
              <div>
                <div className="font-semibold">{a.title}</div>
                <div className="num text-sm text-muted">{a.on ? a.price : 'Turned off'}</div>
              </div>
            </>
          );
          return disabled ? (
            <div key={a.key} className="card flex items-center gap-4 p-4 opacity-50" aria-disabled>
              {inner}
            </div>
          ) : a.to.startsWith('/') && signedIn ? (
            <Link key={a.key} to={a.to} className="card flex items-center gap-4 p-4 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-line-strong">
              {inner}
            </Link>
          ) : (
            <a key={a.key} href={actionHref(a.to)} className="card flex items-center gap-4 p-4 transition-colors hover:border-line-strong">
              {inner}
            </a>
          );
        })}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="card p-5" aria-labelledby="sounds-h">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="sounds-h" className="text-lg font-semibold">
              Popular sounds
            </h2>
            {f.sounds && (
              <Link to={`/sounds?streamer=${s.slug}`} className="text-sm font-medium text-volt hover:underline">
                Open soundboard
              </Link>
            )}
          </div>
          {sounds.isLoading ? (
            <Skeleton className="h-24" />
          ) : sounds.data?.items.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {sounds.data.items.slice(0, 6).map((snd) => (
                <div key={snd.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                  <SoundIcon icon={snd.icon} color={snd.color} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{snd.name}</div>
                    <div className="text-xs text-subtle">{snd.category.name}</div>
                  </div>
                  <span className="num text-sm font-semibold text-volt">{fmtPoints(snd.pricePoints)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No sounds yet.</p>
          )}
        </section>

        <aside className="card p-5" aria-labelledby="pricing-h">
          <h2 id="pricing-h" className="text-lg font-semibold">
            Pricing
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            {[
              [MessageSquare, 'Text message', f.text ? `${fmtPoints(p.text)} pts` : 'Off'],
              [Mic, 'Voice message', f.voice ? `${fmtPoints(p.voice)} pts` : 'Off'],
              [FileAudio, 'Audio clip (MP3)', f.mp3 ? `${fmtPoints(p.mp3)} pts` : 'Off'],
              [Zap, 'Priority boost', `+${fmtPoints(p.priority)} pts`],
              [Timer, 'Max audio length', `${s.limits!.maxAudioSeconds}s`],
              [HandCoins, 'Donations', f.donations ? `${fmtMoney(s.donations!.minCents, cfg?.currency)} – ${fmtMoney(s.donations!.maxCents, cfg?.currency)}` : 'Off'],
            ].map(([Icon, k, v]) => {
              const C = Icon as typeof Mic;
              return (
                <div key={k as string} className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-2 text-muted">
                    <C className="size-4" aria-hidden /> {k as string}
                  </dt>
                  <dd className="num font-semibold">{v as string}</dd>
                </div>
              );
            })}
          </dl>
          <div className="mt-5 flex flex-wrap gap-1.5">
            <Badge tone={s.approvalMode === 'AUTO' ? 'success' : 'amber'}>{s.approvalMode === 'AUTO' ? 'Auto-approved' : 'Reviewed before airing'}</Badge>
            {!!s.limits!.cooldownSeconds && <Badge>{s.limits!.cooldownSeconds}s cooldown</Badge>}
          </div>
        </aside>
      </div>
    </div>
  );
}
