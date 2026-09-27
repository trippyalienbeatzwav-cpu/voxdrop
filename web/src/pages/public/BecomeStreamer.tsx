import { Link } from 'react-router-dom';
import { ArrowRight, AudioLines, Check, Gift, HandCoins, MonitorPlay, ShieldCheck, Trophy } from 'lucide-react';
import { useMe } from '../../lib/session';
import { ButtonLink } from '../../components/ui/Button';

const FEATURES = [
  { icon: AudioLines, title: 'Voice & MP3 messages', body: 'Viewers send voice notes, MP3s and sounds. Each plays after a spoken “Voice message from {name}” intro.' },
  { icon: Trophy, title: 'Points priority queue', body: 'Viewers spend points to move up — with waiting-time fairness so nobody is stuck forever.' },
  { icon: Gift, title: 'Sub & gift-sub rewards', body: 'Verified Kick events reward subscribers with points and trigger your alerts automatically.' },
  { icon: HandCoins, title: 'Donation alerts', body: 'Alerts appear only after the payment provider confirms the payment on the server.' },
  { icon: MonitorPlay, title: 'Four OBS overlays', body: 'Separate Browser Sources for audio, subs, gift subs and donations — each with its own secret URL.' },
  { icon: ShieldCheck, title: 'You stay in control', body: 'Manual or automatic moderation, blocked words, bans, and nothing ever skips moderation.' },
];

/** /become-streamer — marketing + CTA into the streamer sign-in/sign-up flow. */
export default function BecomeStreamer() {
  const me = useMe().data;
  const isStreamer = (me?.channels ?? []).some((c) => c.access === 'owner');
  return (
    <div className="grid-bg">
      <section className="mx-auto max-w-5xl px-4 pb-12 pt-16 text-center sm:px-6 sm:pt-24">
        <p className="label-caps text-volt">For Kick streamers</p>
        <h1 className="mx-auto mt-4 max-w-3xl text-balance text-4xl font-bold leading-tight sm:text-6xl">Turn Your Kick Stream Into an Interactive Experience</h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-muted">
          Let your chat talk to you — literally. Voice messages, sound effects, priority requests and alerts, all in one studio that plugs into OBS in a couple of minutes.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {isStreamer ? (
            <ButtonLink to="/streamer/dashboard" variant="primary" size="lg" icon={<ArrowRight className="size-5" />}>
              Open your studio
            </ButtonLink>
          ) : (
            <ButtonLink to="/streamer/login" variant="kick" size="lg" icon={<ArrowRight className="size-5" />}>
              Become a Streamer
            </ButtonLink>
          )}
          <ButtonLink to="/streamers" variant="ghost" size="lg">
            See it on live channels
          </ButtonLink>
        </div>
        <ul className="mx-auto mt-8 flex max-w-2xl flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-muted">
          {['Free to start', 'Sign in with Kick', 'Your viewer account stays the same'].map((t) => (
            <li key={t} className="flex items-center gap-1.5">
              <Check className="size-4 text-volt" aria-hidden /> {t}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6" aria-labelledby="feat-h">
        <h2 id="feat-h" className="sr-only">What you get</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title} className="card p-5">
              <span className="flex size-10 items-center justify-center rounded-xl bg-volt/10 text-volt">
                <f.icon className="size-5" aria-hidden />
              </span>
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted">{f.body}</p>
            </li>
          ))}
        </ul>
        <ol className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            ['Sign in with Kick', 'We verify your Kick account and channel through Kick’s official OAuth.'],
            ['We set up your studio', 'Profile, queue, alert styles and four OBS overlay URLs are created for you.'],
            ['Add overlays to OBS', 'Copy each URL into a Browser Source — you’re live.'],
          ].map(([t, b], i) => (
            <li key={t} className="rounded-2xl border border-line p-5">
              <span className="num text-sm font-bold text-volt">0{i + 1}</span>
              <h3 className="mt-2 font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-muted">{b}</p>
            </li>
          ))}
        </ol>
        {!isStreamer && (
          <p className="mt-10 text-center text-sm text-muted">
            Already set up?{' '}
            <Link to="/streamer/login" className="font-semibold text-volt hover:underline">
              Streamer sign in
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
