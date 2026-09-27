import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Coins, Gift, ListMusic, Receipt, RotateCcw, ShoppingBag, SlidersHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { post, qs } from '../../lib/api';
import { cx, fmtDateTime, fmtPoints } from '../../lib/format';
import type { Message, PointsTx } from '../../lib/types';
import { EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Tabs } from '../../components/ui/Tabs';
import { Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { LoadMore, MessageCard, usePaged } from '../../components/shared';
import { QueuePositionCard } from '../../components/QueuePriority';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast } from '../../components/ui/Toast';

const TX_META: Record<string, { label: string; icon: React.ReactNode; tone: string }> = {
  POINTS_EARNED: { label: 'Earned', icon: <Sparkles className="size-4" />, tone: 'text-cyan bg-cyan/10' },
  POINTS_SPENT: { label: 'Spent', icon: <ArrowUpRight className="size-4" />, tone: 'text-muted bg-overlay' },
  POINTS_SPENT_PRIORITY: { label: 'Priority', icon: <Zap className="size-4" />, tone: 'text-amber bg-amber/10' },
  POINTS_PURCHASED: { label: 'Purchased', icon: <ShoppingBag className="size-4" />, tone: 'text-volt bg-volt/10' },
  POINTS_REWARDED: { label: 'Reward', icon: <Gift className="size-4" />, tone: 'text-magenta bg-magenta/10' },
  POINTS_REFUNDED: { label: 'Refund', icon: <RotateCcw className="size-4" />, tone: 'text-success bg-success/10' },
  POINTS_ADJUSTED: { label: 'Adjustment', icon: <SlidersHorizontal className="size-4" />, tone: 'text-amber bg-amber/10' },
  POINTS_EXPIRED: { label: 'Expired', icon: <ArrowDownLeft className="size-4" />, tone: 'text-danger bg-danger/10' },
};

export default function History({ tab }: { tab: 'points' | 'messages' }) {
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="History" subtitle="Every point and message, in one place." />
      <Tabs
        label="History type"
        value={tab}
        onChange={(v) => nav(v === 'points' ? '/history' : '/history/messages')}
        tabs={[
          { value: 'points', label: 'Transactions', icon: <Receipt className="size-4" /> },
          { value: 'messages', label: 'My messages', icon: <ListMusic className="size-4" /> },
        ]}
        className="mb-5"
      />
      {tab === 'points' ? <Transactions /> : <MyMessages />}
    </div>
  );
}

function Transactions() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const q = usePaged<PointsTx>(['points-tx', type], (cursor) => `/api/points/transactions${qs({ type, cursor, limit: 25 })}`);
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Select value={type} onChange={(e) => setParams(e.target.value ? { type: e.target.value } : {}, { replace: true })} aria-label="Filter by type" className="sm:w-56">
          <option value="">All transactions</option>
          {Object.entries(TX_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <SkeletonList />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.items.length ? (
        <EmptyState icon={<Coins />} title="No transactions yet" body="Claim your daily check-in or subscribe on Kick to earn your first points." />
      ) : (
        <div className="card divide-y divide-line">
          {q.items.map((t) => {
            const m = TX_META[t.type] ?? TX_META.POINTS_ADJUSTED!;
            return (
              <div key={t.id} className="flex items-center gap-4 p-4">
                <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', m.tone)} aria-hidden>
                  {m.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.description}</p>
                  <p className="text-xs text-subtle">
                    {m.label} · {fmtDateTime(t.created_at)}
                    {t.streamer_display_name && ` · ${t.streamer_display_name}`}
                  </p>
                </div>
                <div className="text-right">
                  <div className={cx('num font-semibold', t.amount > 0 ? 'text-success' : 'text-fg')}>
                    {t.amount > 0 ? '+' : '−'}
                    {fmtPoints(Math.abs(t.amount))}
                  </div>
                  <div className="num text-xs text-subtle">bal {fmtPoints(t.balance_after)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <LoadMore q={q} />
    </>
  );
}

function MyMessages() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const q = usePaged<Message>(['my-messages', status, type], (cursor) => `/api/messages${qs({ status, type, cursor, limit: 20 })}`);
  const qc = useQueryClient();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/api/messages/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-messages'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <Select value={type} onChange={(e) => set('type', e.target.value)} aria-label="Filter by message type" className="sm:w-44">
          <option value="">All types</option>
          <option value="TEXT">Text</option>
          <option value="VOICE">Voice</option>
          <option value="MP3">Audio clip</option>
          <option value="SOUND">Sound</option>
        </Select>
        <Select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Filter by status" className="sm:w-44">
          <option value="">All statuses</option>
          {['PENDING', 'QUEUED', 'PLAYING', 'PLAYED', 'REJECTED', 'EXPIRED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <SkeletonList />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.items.length ? (
        <EmptyState icon={<ListMusic />} title="No messages yet" body="Send a text, voice note or sound to a streamer and it’ll show up here." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {q.items.map((m) => (
            <MessageCard
              key={m.id}
              m={m}
              showStreamer
              footer={['APPROVED', 'QUEUED', 'PLAYING'].includes(m.status) ? <QueuePositionCard messageId={m.id} className="mt-3 p-3" /> : undefined}
              actions={
                m.status === 'PENDING' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X className="size-4" />}
                    loading={cancel.isPending && cancel.variables === m.id}
                    onClick={async () => {
                      if (await confirm({ title: 'Cancel this message?', body: m.pointsSpent ? `${fmtPoints(m.pointsSpent)} points will be refunded.` : undefined, confirmLabel: 'Cancel message', tone: 'danger' })) cancel.mutate(m.id);
                    }}
                  >
                    Cancel & refund
                  </Button>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      <LoadMore q={q} />
    </>
  );
}
