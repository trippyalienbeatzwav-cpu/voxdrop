import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarCheck, Coins, FileAudio, Gift, Megaphone, Mic, Music2, ShoppingBag, Sparkles, Zap } from 'lucide-react';
import { get, post } from '../../lib/api';
import { fmtMoney, fmtPoints } from '../../lib/format';
import { useConfig, useMe } from '../../lib/session';
import { Badge, PageHeader, Points, Skeleton } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

interface Pkg {
  id: string;
  name: string;
  points: number;
  bonus_label: string | null;
  price_cents: number;
  currency: string;
}

const SHOP = [
  { icon: Mic, title: 'Voice Message', body: 'Record your voice and hear it played live on stream.', price: 'from 150', to: '/voice', tone: 'text-volt bg-volt/10' },
  { icon: FileAudio, title: 'MP3 Message', body: 'Upload a short audio clip (MP3 or WAV).', price: 'from 250', to: '/voice', tone: 'text-violet bg-violet/10' },
  { icon: Music2, title: 'Sound Effects', body: 'Fire a sound from the streamer’s soundboard.', price: 'from 50', to: '/sounds', tone: 'text-magenta bg-magenta/10' },
  { icon: Zap, title: 'Priority Message', body: 'Skip ahead of the regular queue.', price: '+200', to: '/send', tone: 'text-amber bg-amber/10' },
  { icon: Megaphone, title: 'Special Alerts', body: 'Add bonus points to any message for a bigger on-stream alert.', price: 'you choose', to: '/send', tone: 'text-cyan bg-cyan/10' },
];

export default function PointsShop() {
  const me = useMe();
  const cfg = useConfig().data;
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const points = useQuery({ queryKey: ['points'], queryFn: () => get<{ balance: number; lifetimeEarned: number; lifetimeSpent: number; totalsByType: Record<string, number> }>('/api/points') });
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => get<{ items: Pkg[] }>('/api/points/packages'), staleTime: 300_000 });

  // Returning from checkout
  useEffect(() => {
    const status = params.get('status');
    if (!params.get('purchase') || !status) return;
    if (status === 'success') toast({ title: 'Payment received', body: 'Your points will appear as soon as the payment is confirmed.', tone: 'success' });
    else toast({ title: 'Purchase cancelled', body: 'You were not charged.', tone: 'warning' });
    qc.invalidateQueries({ queryKey: ['me'] });
    setParams({}, { replace: true });
  }, [params, setParams, toast, qc]);

  const daily = useMutation({
    mutationFn: () => post<{ awarded: number }>('/api/me/daily-bonus'),
    onSuccess: (r) => {
      toast({ title: `+${r.awarded} points`, body: 'Daily check-in claimed. See you tomorrow!', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['points'] });
    },
    onError,
  });
  const buy = useMutation({
    mutationFn: (p: Pkg) => post<{ checkoutUrl: string }>('/api/points/purchase', { packageId: p.id }),
    onSuccess: (r) => window.location.assign(r.checkoutUrl),
    onError,
  });

  const balance = points.data?.balance ?? me.data?.points ?? 0;
  return (
    <div>
      <PageHeader title="Points shop" subtitle="Points have no cash value — they’re how you get your voice on stream." />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card-raised relative overflow-hidden p-6 lg:col-span-2" aria-label="Balance">
          <div className="pointer-events-none absolute -right-10 -top-10 size-56 rounded-full bg-volt/10 blur-3xl" />
          <p className="label-caps">Your balance</p>
          <div className="mt-2">
            <Points value={balance} size="lg" className="text-4xl [&>svg]:size-8" />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-subtle">Lifetime earned</dt>
              <dd className="num font-semibold">{fmtPoints(points.data?.lifetimeEarned)}</dd>
            </div>
            <div>
              <dt className="text-subtle">Lifetime spent</dt>
              <dd className="num font-semibold">{fmtPoints(points.data?.lifetimeSpent)}</dd>
            </div>
            <div>
              <dt className="text-subtle">From sub rewards</dt>
              <dd className="num font-semibold">{fmtPoints(points.data?.totalsByType.POINTS_REWARDED)}</dd>
            </div>
          </dl>
        </section>
        <section className="card flex flex-col justify-between gap-4 p-6" aria-label="Daily check-in">
          <div>
            <CalendarCheck className="size-6 text-cyan" aria-hidden />
            <h2 className="mt-3 text-lg font-semibold">Daily check-in</h2>
            <p className="text-sm text-muted">Claim {cfg?.dailyBonusPoints ?? 25} free points every day.</p>
          </div>
          <Button variant={me.data?.user?.dailyBonusAvailable ? 'primary' : 'secondary'} disabled={!me.data?.user?.dailyBonusAvailable} loading={daily.isPending} onClick={() => daily.mutate()}>
            {me.data?.user?.dailyBonusAvailable ? `Claim +${cfg?.dailyBonusPoints ?? 25}` : 'Come back tomorrow'}
          </Button>
        </section>
      </div>

      <h2 className="mb-4 mt-10 text-xl font-semibold">Spend points</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {SHOP.map((it) => {
          const Icon = it.icon;
          return (
            <div key={it.title} className="card flex flex-col gap-3 p-5">
              <span className={`flex size-11 items-center justify-center rounded-xl ${it.tone}`}>
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="font-semibold">{it.title}</h3>
              <p className="flex-1 text-sm text-muted">{it.body}</p>
              <div className="num text-sm font-semibold text-volt">{it.price} pts</div>
              <Button size="sm" onClick={() => nav(it.to)}>
                Use
              </Button>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-subtle">Exact prices are set by each streamer and shown before you confirm.</p>

      <h2 className="mb-1 mt-10 flex items-center gap-2 text-xl font-semibold">
        <ShoppingBag className="size-5 text-volt" aria-hidden /> Get more points
      </h2>
      <p className="mb-4 text-sm text-muted">
        Earn points by subscribing or gifting subs on connected Kick channels — or grab a pack. Payments are processed by {cfg?.paymentProvider === 'stripe' ? 'Stripe' : 'the payment provider'}; card details never touch VoxDrop.
      </p>
      {packages.isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {packages.data?.items.map((p, i) => (
            <div key={p.id} className={`card relative flex flex-col gap-3 p-5 ${i === 1 ? 'border-volt/40' : ''}`}>
              {i === 1 && (
                <Badge tone="volt" className="absolute right-4 top-4">
                  <Sparkles className="size-3" aria-hidden /> Popular
                </Badge>
              )}
              <Coins className="size-6 text-volt" aria-hidden />
              <div>
                <div className="text-sm text-muted">{p.name}</div>
                <div className="num font-display text-2xl font-semibold">{fmtPoints(p.points)}</div>
                {p.bonus_label && <div className="text-xs text-success">{p.bonus_label}</div>}
              </div>
              <Button
                variant={i === 1 ? 'primary' : 'secondary'}
                loading={buy.isPending && buy.variables?.id === p.id}
                onClick={async () => {
                  if (await confirm({ title: `Buy ${fmtPoints(p.points)} points for ${fmtMoney(p.price_cents, p.currency)}?`, body: 'You’ll be taken to a secure checkout. Points are added once the payment is confirmed.', confirmLabel: 'Continue to checkout' })) buy.mutate(p);
                }}
              >
                {fmtMoney(p.price_cents, p.currency)}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 flex items-start gap-3 rounded-xl border border-line p-4 text-sm text-muted">
        <Gift className="size-5 shrink-0 text-magenta" aria-hidden />
        Subscribed or gifted subs before you joined? Those rewards are waiting — they were added to your balance automatically when you first signed in.
      </div>
    </div>
  );
}
