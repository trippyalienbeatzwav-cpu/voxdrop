import { useId, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, MessageSquare, Send, Zap } from 'lucide-react';
import { ApiError, post } from '../../lib/api';
import { fmtPoints, newIdempotencyKey } from '../../lib/format';
import type { Message } from '../../lib/types';
import { useCountdown, useQuote, useStreamer } from '../../lib/hooks';
import { ErrorState, PageHeader, Skeleton, StatusBadge } from '../../components/ui/Feedback';
import { Field, NumberField, Switch, Textarea } from '../../components/ui/Field';
import { Button, ButtonLink } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast } from '../../components/ui/Toast';
import { SpendSummary } from '../../components/SpendSummary';
import { StreamerMini } from '../../components/StreamerMini';
import { PriorityPicker, QueuePositionCard, spendConfirmCopy, usePriorityOptions } from '../../components/QueuePriority';
import type { TierKey } from '../../components/priority';

const MAX = 300;

export default function SendMessage() {
  const { streamer: slug } = useParams();
  const s = useStreamer(slug);
  const [text, setText] = useState('');
  const [tier, setTier] = useState<TierKey | null>(null);
  const [bonus, setBonus] = useState(0);
  const [sent, setSent] = useState<Message | null>(null);
  const idemKey = useMemo(() => newIdempotencyKey(), [sent]); // new key per logical send
  const safeBonus = Number.isFinite(bonus) ? bonus : 0;
  const prio = usePriorityOptions(slug, { type: 'TEXT', bonus: safeBonus });
  const priorityTier = prio.data?.enabled ? tier : null;
  const quote = useQuote(slug, { type: 'TEXT', priorityTier, bonus: safeBonus }, !prio.isLoading);
  const tierOpt = prio.data?.tiers.find((t) => t.tier === priorityTier);
  const cooldown = useCountdown(quote.data?.cooldownRemaining);
  const confirm = useConfirm();
  const onError = useErrorToast();
  const qc = useQueryClient();
  const textId = useId();

  const send = useMutation({
    mutationFn: () => post<{ message: Message }>('/api/messages', { streamerId: s.data!.streamer.id, type: 'TEXT', text, ...(priorityTier ? { priorityTier } : {}), bonusPoints: bonus || 0 }, { 'Idempotency-Key': idemKey }),
    onSuccess: (r) => {
      setSent(r.message);
      setText('');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['quote'] });
      qc.invalidateQueries({ queryKey: ['priority-options'] });
    },
    onError,
  });

  if (s.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (s.error) return <ErrorState error={s.error} onRetry={() => s.refetch()} />;
  const st = s.data!.streamer;
  if (!st.features?.text) return <ErrorState error={new ApiError(403, 'FEATURE_DISABLED', `${st.displayName} has turned off text messages.`)} />;

  const total = quote.data?.price.total ?? 0;
  const tooLong = text.length > MAX;
  const canSend = text.trim().length > 0 && !tooLong && !!quote.data?.affordable && cooldown <= 0 && !send.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    if (total > 0 && !(await confirm(spendConfirmCopy(tierOpt, total, 'text message', st.displayName, st.approvalMode === 'MANUAL')))) return;
    send.mutate();
  }

  if (sent)
    return (
      <div className="mx-auto max-w-xl py-10 text-center">
        <CheckCircle2 className="mx-auto size-14 text-success" aria-hidden />
        <h1 className="mt-4 text-2xl font-semibold">Message sent to {st.displayName}</h1>
        <div className="mt-3 flex justify-center">
          <StatusBadge status={sent.status} />
        </div>
        <QueuePositionCard messageId={sent.id} className="mt-5" />
        <p className="mt-3 text-muted">{sent.status === 'PENDING' ? 'It’s waiting for review. We’ll notify you when it’s approved or played.' : 'It’s in the queue and will play on stream soon.'}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => setSent(null)}>
            Send another
          </Button>
          <ButtonLink to="/history/messages">View my messages</ButtonLink>
        </div>
      </div>
    );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Send a message" subtitle={<>Your message appears on {st.displayName}’s stream.</>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={submit} className="space-y-5">
          <StreamerMini s={st} />
          <div className="card space-y-5 p-5">
            <Field
              htmlFor={textId}
              label="Your message"
              error={tooLong ? `Keep it under ${MAX} characters` : null}
              hint={<span className="num">{text.length}/{MAX}</span>}
            >
              <Textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Say something nice…" invalid={tooLong} maxLength={MAX + 50} aria-describedby={`${textId}-hint`} />
            </Field>
            <PriorityPicker options={prio.data} loading={prio.isLoading} value={tier} onChange={setTier} />
            <NumberField label="Bonus points (optional)" value={bonus} onChange={setBonus} min={0} max={100000} suffix="pts" hint="Shown on the overlay alert — a tip in points." />
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!canSend} loading={send.isPending} icon={priorityTier && priorityTier !== 'NORMAL' ? <Zap className="size-4" /> : <Send className="size-4" />}>
            {total === 0 ? 'Send for free' : `Send · ${fmtPoints(total)} points`}
          </Button>
        </form>
        <aside className="space-y-4">
          <SpendSummary quote={quote.data} loading={quote.isLoading} cooldownLeft={cooldown} />
          <div className="card p-4 text-sm text-muted">
            <p className="flex items-center gap-2 font-semibold text-fg">
              <MessageSquare className="size-4 text-cyan" aria-hidden /> Want to be heard?
            </p>
            <p className="mt-1">
              Voice messages play your actual voice on stream.{' '}
              <Link to={`/voice/${st.slug}`} className="font-semibold text-volt hover:underline">
                Record one
              </Link>
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
