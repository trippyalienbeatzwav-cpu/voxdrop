import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CreditCard, HandCoins, Heart, Lock, Mic, X } from 'lucide-react';
import { errorCopy, post, uploadWithProgress } from '../../lib/api';
import { cx, fmtDateTime, fmtMoney } from '../../lib/format';
import { useStreamer } from '../../lib/hooks';
import { useConfig } from '../../lib/session';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Field, Input, Switch, Textarea } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Modal, useConfirm } from '../../components/ui/Modal';
import { useErrorToast } from '../../components/ui/Toast';
import { Recorder } from '../../components/audio/Recorder';
import { LoadMore, usePaged } from '../../components/shared';
import { StreamerMini } from '../../components/StreamerMini';
import { StreamerPickerList } from './StreamerPicker';

interface MyDonation {
  id: string;
  amount_cents: number;
  currency: string;
  message: string;
  status: string;
  created_at: string;
  has_voice: boolean;
  streamer_slug: string;
  streamer_display_name: string;
  streamer_avatar: string | null;
}

const STATUS_TONE: Record<string, 'success' | 'amber' | 'danger' | 'neutral' | 'cyan'> = { COMPLETED: 'success', PENDING: 'amber', FAILED: 'danger', REFUNDED: 'cyan', CANCELLED: 'neutral' };

export default function Donations() {
  const [params] = useSearchParams();
  const slug = params.get('streamer') ?? undefined;
  const mine = usePaged<MyDonation>(['my-donations'], (cursor) => `/api/donations?limit=20${cursor ? `&cursor=${cursor}` : ''}`);
  return (
    <div>
      <PageHeader title="Donations" subtitle="Support streamers with real money — separate from points, processed by a secure checkout." />
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <section aria-label="Donate">{slug ? <DonateForm slug={slug} /> : <PickStreamer />}</section>
        <section aria-labelledby="my-don-h">
          <h2 id="my-don-h" className="mb-3 text-lg font-semibold">
            Your donations
          </h2>
          {mine.isLoading ? (
            <SkeletonList rows={3} />
          ) : mine.error ? (
            <ErrorState error={mine.error} onRetry={() => mine.refetch()} />
          ) : !mine.items.length ? (
            <EmptyState icon={<Heart />} title="No donations yet" body="Your donation history and receipts will appear here." />
          ) : (
            <ul className="space-y-2">
              {mine.items.map((d) => (
                <li key={d.id} className="card flex items-center gap-3 p-3">
                  <Avatar src={d.streamer_avatar} name={d.streamer_display_name} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{d.streamer_display_name}</p>
                    <p className="text-xs text-subtle">{fmtDateTime(d.created_at)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="num text-sm font-semibold">{fmtMoney(d.amount_cents, d.currency)}</span>
                    <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status.toLowerCase()}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <LoadMore q={mine} />
        </section>
      </div>
    </div>
  );
}

function PickStreamer() {
  return (
    <div>
      <p className="mb-4 text-muted">Who would you like to support?</p>
      <StreamerPickerList mode="send" />
      <p className="mt-2 text-xs text-subtle">Pick a streamer, then open “Donate” on their profile.</p>
    </div>
  );
}

function DonateForm({ slug }: { slug: string }) {
  const s = useStreamer(slug);
  const cfg = useConfig().data;
  const currency = cfg?.currency ?? 'usd';
  const [amount, setAmount] = useState('5');
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [voice, setVoice] = useState<{ id: string; durationMs: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const confirm = useConfirm();
  const onError = useErrorToast();
  const amountId = useId();
  const msgId = useId();

  const donate = useMutation({
    mutationFn: () => post<{ checkoutUrl: string }>('/api/donations', { streamerId: s.data!.streamer.id, amountCents: Math.round(Number(amount) * 100), message, anonymous, audioFileId: voice?.id }),
    onSuccess: (r) => window.location.assign(r.checkoutUrl),
    onError,
  });

  if (s.isLoading) return <SkeletonList rows={2} />;
  if (s.error) return <ErrorState error={s.error} />;
  const st = s.data!.streamer;
  if (!st.features?.donations) return <EmptyState icon={<HandCoins />} title={`${st.displayName} isn’t accepting donations`} />;
  const min = st.donations!.minCents / 100;
  const max = st.donations!.maxCents / 100;
  const cents = Math.round(Number(amount) * 100);
  const amountError = !amount || Number.isNaN(Number(amount)) ? 'Enter an amount' : cents < st.donations!.minCents ? `Minimum is ${fmtMoney(st.donations!.minCents, currency)}` : cents > st.donations!.maxCents ? `Maximum is ${fmtMoney(st.donations!.maxCents, currency)}` : null;

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (amountError) return;
        if (await confirm({ title: `Donate ${fmtMoney(cents, currency)} to ${st.displayName}?`, body: 'You’ll be taken to a secure checkout to pay. Your donation is confirmed only after the payment succeeds.', confirmLabel: 'Continue to checkout' })) donate.mutate();
      }}
    >
      <StreamerMini s={st} />
      <div className="card space-y-5 p-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Amount</legend>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[3, 5, 10, 25].filter((v) => v >= min && v <= max).map((v) => (
              <button type="button" key={v} onClick={() => setAmount(String(v))} aria-pressed={Number(amount) === v} className={cx('h-11 rounded-xl border text-sm font-semibold transition-colors', Number(amount) === v ? 'border-magenta bg-magenta/15 text-magenta' : 'border-line hover:border-line-strong')}>
                {fmtMoney(v * 100, currency)}
              </button>
            ))}
          </div>
          <Field htmlFor={amountId} label="Custom amount" error={amountError} hint={`${fmtMoney(st.donations!.minCents, currency)} – ${fmtMoney(st.donations!.maxCents, currency)}`}>
            <Input id={amountId} type="number" inputMode="decimal" min={min} max={max} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!amountError} className="num" />
          </Field>
        </fieldset>
        <Field htmlFor={msgId} label="Message (optional)" hint="Shown on stream with your donation alert.">
          <Textarea id={msgId} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} rows={3} />
        </Field>
        {st.features.donationVoice && (
          <div className="rounded-xl border border-line p-4">
            {voice ? (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <Mic className="size-4 text-volt" aria-hidden /> Voice note attached ({Math.round(voice.durationMs / 1000)}s)
                </span>
                <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setVoice(null)}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => setRecording(true)} icon={<Mic className="size-4" />}>
                Add a voice note
              </Button>
            )}
          </div>
        )}
        <Switch checked={anonymous} onChange={setAnonymous} label="Donate anonymously" description="Your name is hidden on stream and in the streamer’s feed." />
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!!amountError} loading={donate.isPending} icon={<CreditCard className="size-4" />}>
        Donate {amountError ? '' : fmtMoney(cents, currency)}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-subtle">
        <Lock className="size-3.5" aria-hidden /> Card details are handled by the payment provider, never stored by VoxDrop. <Link to="/#faq" className="underline">FAQ</Link>
      </p>

      <Modal open={recording} onClose={() => setRecording(false)} title="Record a voice note" size="lg">
        <Recorder
          maxSeconds={st.limits!.maxAudioSeconds}
          sendLabel="Attach to donation"
          onSend={async (wav, durationMs, onProgress) => {
            const form = new FormData();
            form.append('streamerId', st.id);
            form.append('purpose', 'DONATION');
            form.append('file', wav, 'donation-voice.wav');
            try {
              const r = await uploadWithProgress<{ audio: { id: string } }>('/api/audio/upload', form, onProgress);
              setVoice({ id: r.audio.id, durationMs });
              setRecording(false);
            } catch (err) {
              const c = errorCopy(err);
              throw new Error(`${c.title}: ${c.body}`);
            }
          }}
        />
      </Modal>
    </form>
  );
}
