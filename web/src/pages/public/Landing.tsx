import { Link } from 'react-router-dom';
import {
  ArrowRight, AudioLines, Check, ChevronDown, Coins, Gift, HandCoins, LogIn, MessageSquare, Mic, MonitorPlay, Music2, Pause, Play, ShieldCheck,
  SkipForward, Sparkles, Timer, UserX, X, Zap,
} from 'lucide-react';
import { kickLoginHref, useMe } from '../../lib/session';
import { Waveform } from '../../components/audio/Waveform';
import { Avatar, Badge } from '../../components/ui/Feedback';
import { SoundIcon } from '../../components/shared';
import { ButtonLink } from '../../components/ui/Button';

const demoPeaks = Array.from({ length: 64 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)));

function KickCta({ size = 'lg' }: { size?: 'md' | 'lg' }) {
  const me = useMe().data;
  if (me?.user)
    return (
      <ButtonLink to="/home" variant="primary" size={size} icon={<ArrowRight className="size-4" />}>
        Open dashboard
      </ButtonLink>
    );
  return (
    <a href={kickLoginHref('/home')} className={`inline-flex items-center justify-center gap-2 rounded-xl bg-kick font-semibold text-black shadow-[0_10px_32px_-10px_rgb(83_252_24/0.7)] transition-colors hover:bg-[#6dff3a] ${size === 'lg' ? 'h-13 px-6 text-base' : 'h-11 px-4'}`}>
      <LogIn className="size-4" aria-hidden /> Continue with Kick
    </a>
  );
}

/** Static illustration of the product (sample data, clearly not live). */
function ProductPreview() {
  const queue = [
    { name: 'mochimilk', type: 'Voice', icon: <Mic className="size-3" />, pts: 400, tone: 'volt' as const, priority: true, dur: '0:14' },
    { name: 'pixelpete', type: 'Text', icon: <MessageSquare className="size-3" />, pts: 50, tone: 'cyan' as const, dur: '—' },
    { name: 'drift_king', type: 'Sound', icon: <Music2 className="size-3" />, pts: 100, tone: 'magenta' as const, dur: '0:02' },
  ];
  return (
    <div className="relative mx-auto w-full max-w-xl" aria-label="Product preview illustration" role="img">
      <div className="absolute -inset-8 -z-10 rounded-[40px] bg-[radial-gradient(ellipse_at_top,rgb(255_212_59/0.18),transparent_60%)] blur-2xl" />
      <div className="card-raised overflow-hidden shadow-[var(--shadow-pop)]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AudioLines className="size-4 text-volt" /> Live queue
          </div>
          <Badge tone="magenta" dot>
            LIVE
          </Badge>
        </div>
        <div className="space-y-3 p-4">
          <div className="rounded-xl border border-volt/30 bg-volt/[0.06] p-3.5">
            <div className="flex items-center gap-3">
              <Avatar name="nova fan" size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  lunartide <Badge tone="volt" dot>Playing</Badge>
                </div>
                <p className="truncate text-xs text-muted">“That clutch was unreal, GG!”</p>
              </div>
              <span className="num text-sm font-semibold text-volt">250</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-volt text-on-volt">
                <Pause className="size-3.5" fill="currentColor" />
              </span>
              <Waveform peaks={demoPeaks} progress={0.42} height={28} className="flex-1" />
              <span className="num text-xs text-muted">0:06</span>
            </div>
          </div>
          {queue.map((q, i) => (
            <div key={q.name} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
              <span className="num w-4 text-xs text-subtle">{i + 1}</span>
              <Avatar name={q.name} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {q.name}
                  {q.priority && <Zap className="size-3.5 text-volt" />}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge tone={q.tone}>
                    {q.icon}
                    {q.type}
                  </Badge>
                  <span className="text-[11px] text-subtle">{q.dur}</span>
                </div>
              </div>
              <div className="hidden gap-1 sm:flex">
                <span className="flex size-8 items-center justify-center rounded-lg bg-raised text-muted"><Play className="size-3.5" /></span>
                <span className="flex size-8 items-center justify-center rounded-lg bg-raised text-muted"><SkipForward className="size-3.5" /></span>
                <span className="flex size-8 items-center justify-center rounded-lg bg-raised text-muted"><X className="size-3.5" /></span>
              </div>
              <span className="num w-10 text-right text-sm font-semibold text-volt">{q.pts}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Floating overlay alert */}
      <div className="absolute -bottom-8 -left-4 hidden w-72 rotate-[-2deg] rounded-2xl border border-magenta/40 bg-canvas/95 p-4 shadow-[0_20px_60px_-15px_rgb(255_61_139/0.5)] sm:block">
        <div className="flex items-center gap-3">
          <Avatar name="pixelpete" size={40} ring="var(--color-magenta)" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-magenta">New donation</p>
            <p className="font-display font-semibold">pixelpete · $5.00</p>
          </div>
        </div>
        <p className="mt-2 text-sm text-muted">“Keep the late streams coming!”</p>
      </div>
    </div>
  );
}

const FAQ = [
  ['Is VoxDrop made by Kick?', 'No. VoxDrop is an independent product that uses Kick’s official login (OAuth) and event webhooks. We never see your Kick password.'],
  ['Are points real money?', 'No. Points have no cash value and can’t be withdrawn. You earn them from subscriptions, gifted subs, check-ins and streamer gifts, or buy them in packs. Donations are separate real-money payments to the streamer.'],
  ['How do sub rewards work?', 'When you subscribe or gift subs on a connected channel, Kick notifies VoxDrop and your points arrive automatically. Each event can only pay out once. If you haven’t joined yet, the reward waits for your first login.'],
  ['What happens if my message is rejected?', 'If the channel has refunds on (the default), your points come straight back. Messages that aren’t reviewed in time expire and are refunded too.'],
  ['What audio can I send?', 'Record in your browser or upload an MP3/WAV. Each channel sets its own maximum length (60 seconds by default). Every file is checked and re-encoded on our servers before a streamer ever hears it.'],
  ['How does the stream overlay work?', 'Streamers add a private Browser Source URL in OBS. Approved messages play there one at a time — never overlapping — with the sender’s name, avatar and points.'],
];

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      {/* Hero */}
      <section className="grid-bg relative border-b border-line">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_20%_0%,rgb(255_212_59/0.10),transparent),radial-gradient(ellipse_60%_50%_at_90%_20%,rgb(255_61_139/0.10),transparent)]" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-16 px-4 pb-24 pt-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:px-8 lg:pb-32 lg:pt-24">
          <div className="animate-rise">
            <Badge tone="volt" className="mb-6">
              <Sparkles className="size-3" aria-hidden /> Built for Kick streamers
            </Badge>
            <h1 className="text-5xl font-bold leading-[1.02] tracking-tighter sm:text-6xl lg:text-7xl">
              Your Chat. <br />
              <span className="text-volt">Your Voice.</span> <br />
              Live on Stream.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted sm:text-xl">Let your community send voice messages, sounds, and support directly to your Kick stream.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <KickCta />
              <ButtonLink to="/streamers" size="lg" variant="outline" icon={<MonitorPlay className="size-4" />}>
                Explore Streamers
              </ButtonLink>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
              {['Official Kick login', 'Moderated before it airs', 'OBS-ready overlay'].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check className="size-4 text-volt" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          </div>
          <ProductPreview />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <p className="label-caps">How it works</p>
        <h2 className="mt-2 max-w-2xl text-3xl font-semibold sm:text-4xl">From your mic to their stream in three steps.</h2>
        <ol className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            [LogIn, 'Sign in with Kick', 'One click with your Kick account. Subs and gifted subs you make on connected channels turn into points automatically.'],
            [Mic, 'Record or pick a sound', 'Record a voice note, upload a clip, type a message or fire a sound effect. You see the exact price before you spend.'],
            [MonitorPlay, 'Hear it live', 'The streamer (or their mods) approves it and it plays on stream through the OBS overlay — with your name on screen.'],
          ].map(([Icon, title, body], i) => {
            const C = Icon as typeof Mic;
            return (
              <li key={i} className="card relative p-6">
                <span className="num absolute right-5 top-5 text-5xl font-bold text-line">{i + 1}</span>
                <span className="flex size-11 items-center justify-center rounded-xl bg-volt/10 text-volt">
                  <C className="size-5" aria-hidden />
                </span>
                <h3 className="mt-5 text-lg font-semibold">{title as string}</h3>
                <p className="mt-2 text-muted">{body as string}</p>
              </li>
            );
          })}
        </ol>
      </section>

      {/* Viewers / Streamers */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:px-8">
          <div id="viewers" className="card-raised p-8">
            <Badge tone="cyan">For viewers</Badge>
            <h2 className="mt-4 text-3xl font-semibold">Get heard, not scrolled past.</h2>
            <ul className="mt-6 space-y-3 text-muted">
              {['Record voice messages with live levels, trim and preview', 'Upload short MP3 clips or fire sound effects', 'Earn points from subs, gifted subs and daily check-ins', 'Track every point, message and donation in your history'].map((t) => (
                <li key={t} className="flex gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-cyan" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div id="streamers" className="card-raised p-8">
            <Badge tone="volt">For streamers</Badge>
            <h2 className="mt-4 text-3xl font-semibold">A control room that keeps up with chat.</h2>
            <ul className="mt-6 space-y-3 text-muted">
              {['Live queue with play, skip, priority and drag-to-reorder', 'Approve / reject with keyboard shortcuts — or let mods do it', 'Set every price, limit, cooldown and reward yourself', 'Analytics, donation feed and a complete audit log'].map((t) => (
                <li key={t} className="flex gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-volt" aria-hidden /> {t}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <KickCta size="md" />
            </div>
          </div>
        </div>
      </section>

      {/* Points + Sounds */}
      <section className="mx-auto grid max-w-7xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="label-caps">Points system</p>
          <h2 className="mt-2 text-3xl font-semibold sm:text-4xl">Rewards that follow your support.</h2>
          <p className="mt-4 text-muted">Every point movement is recorded in a tamper-proof ledger. Streamers choose how generous rewards are, with limits that stop farming.</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              [Coins, '+500', 'per subscription', 'text-volt'],
              [Gift, '+750', 'per gifted sub', 'text-magenta'],
              [Zap, '+1,000', 'multi-gift bonus', 'text-cyan'],
            ].map(([Icon, n, l, c]) => {
              const C = Icon as typeof Coins;
              return (
                <div key={l as string} className="card p-5">
                  <C className={`size-5 ${c}`} aria-hidden />
                  <div className="num mt-3 font-display text-2xl font-semibold">{n as string}</div>
                  <div className="text-sm text-subtle">{l as string}</div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-subtle">Example defaults — every value is configurable per channel.</p>
        </div>
        <div>
          <p className="label-caps">Sound library</p>
          <h2 className="mt-2 text-3xl font-semibold sm:text-4xl">A soundboard your chat can press.</h2>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ['megaphone', '#C6FF3D', 'Air Horn', 100],
              ['skull', '#FFB23D', 'Bruh', 50],
              ['hand-metal', '#3DD9FF', 'Applause', 150],
              ['trophy', '#B18CFF', 'Level Up', 120],
              ['laugh', '#FF3D8B', 'Sad Trombone', 90],
              ['ghost', '#B18CFF', 'Jump Scare', 200],
            ].map(([icon, color, name, price]) => (
              <div key={name as string} className="card flex items-center gap-3 p-3">
                <SoundIcon icon={icon as string} color={color as string} size={36} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{name}</div>
                  <div className="num text-xs text-volt">{price} pts</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Donations + Moderation */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 py-24 sm:px-6 md:grid-cols-2 lg:px-8">
          <div className="card-raised p-8">
            <HandCoins className="size-7 text-magenta" aria-hidden />
            <h2 className="mt-4 text-2xl font-semibold">Donations, done properly</h2>
            <p className="mt-3 text-muted">Real-money support goes through a secure hosted checkout — card details never touch VoxDrop. Donations can carry a message or voice note and are kept completely separate from points.</p>
          </div>
          <div className="card-raised p-8">
            <ShieldCheck className="size-7 text-volt" aria-hidden />
            <h2 className="mt-4 text-2xl font-semibold">Nothing airs without your say</h2>
            <p className="mt-3 text-muted">Manual or automatic approval, blocked words, cooldowns, daily limits, queue caps, mutes and bans. Rejected messages are refunded automatically.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Badge tone="amber"><Timer className="size-3" /> Cooldowns</Badge>
              <Badge tone="danger"><UserX className="size-3" /> Bans & mutes</Badge>
              <Badge tone="cyan"><ShieldCheck className="size-3" /> Word filter</Badge>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="label-caps text-center">FAQ</p>
        <h2 className="mt-2 text-center text-3xl font-semibold sm:text-4xl">Questions, answered.</h2>
        <div className="mt-10 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card group p-0 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl p-5 font-semibold">
                {q}
                <ChevronDown className="size-5 shrink-0 text-subtle transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="px-5 pb-5 text-muted">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <div className="card-raised relative overflow-hidden p-10 text-center sm:p-16">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(255_212_59/0.12),transparent_65%)]" />
          <h2 className="relative text-3xl font-semibold sm:text-5xl">Give your chat a voice tonight.</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-muted">Free to join. Connect your Kick channel in under a minute.</p>
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <KickCta />
            <ButtonLink to="/streamers" size="lg" variant="outline">
              Explore Streamers
            </ButtonLink>
          </div>
        </div>
      </section>
      <Link to="/streamers" className="sr-only">
        Browse streamers
      </Link>
    </div>
  );
}
