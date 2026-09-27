import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { HandCoins, Mic, RotateCcw } from 'lucide-react';
import { post, qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtDateTime, fmtMoney } from '../../lib/format';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList, StatCard } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
import { Tabs } from '../../components/ui/Tabs';
import { LoadMore, usePaged } from '../../components/shared';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

interface D {
  id: string;
  amount_cents: number;
  currency: string;
  message: string;
  status: string;
  is_anonymous: boolean;
  created_at: string;
  audio_file_id: string | null;
  donor_display_name: string;
  donor_avatar: string | null;
}
type Summary = Array<{ currency: string; status: string; count: number; total_cents: number }>;

export default function StreamerDonations() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const list = usePaged<D>(['channel-donations', sid, status], (cursor) => `/api/channels/${sid}/donations${qs({ status, cursor, limit: 25 })}`, !!sid);
  const summary = (list.data?.pages[0] as unknown as { summary?: Summary })?.summary ?? [];
  const sum = (st: string) => summary.filter((x) => x.status === st).reduce((a, x) => a + x.total_cents, 0);
  const cnt = (st: string) => summary.filter((x) => x.status === st).reduce((a, x) => a + x.count, 0);
  const cur = summary[0]?.currency ?? 'usd';
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const refund = useMutation({
    mutationFn: (d: D) => post<{ status: string }>(`/api/channels/${sid}/donations/${d.id}/refund`, { reason: 'Refunded by streamer' }),
    onSuccess: (r) => {
      toast({ title: r.status === 'succeeded' ? 'Refund issued' : 'Refund requested', body: r.status === 'pending' ? 'The payment provider is processing it.' : undefined, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['channel-donations'] });
    },
    onError,
  });

  return (
    <div>
      <PageHeader title="Donations" subtitle="Real-money support. Kept completely separate from points." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total received" value={fmtMoney(sum('COMPLETED'), cur)} icon={<HandCoins />} tone="magenta" hint={`${cnt('COMPLETED')} donations`} />
        <StatCard label="Pending" value={fmtMoney(sum('PENDING'), cur)} icon={<HandCoins />} tone="amber" hint={`${cnt('PENDING')} awaiting payment`} />
        <StatCard label="Refunded" value={fmtMoney(sum('REFUNDED'), cur)} icon={<RotateCcw />} tone="cyan" hint={`${cnt('REFUNDED')} refunds`} />
        <StatCard label="Failed" value={cnt('FAILED')} icon={<HandCoins />} tone="violet" hint="declined or expired" />
      </div>
      <Tabs
        label="Donation status"
        value={status}
        onChange={(v) => setParams(v ? { status: v } : {}, { replace: true })}
        className="mb-4"
        tabs={[
          { value: '', label: 'All' },
          { value: 'COMPLETED', label: 'Completed' },
          { value: 'PENDING', label: 'Pending' },
          { value: 'REFUNDED', label: 'Refunded' },
          { value: 'FAILED', label: 'Failed' },
        ]}
      />
      {list.isLoading ? (
        <SkeletonList />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <EmptyState icon={<HandCoins />} title="No donations here yet" />
      ) : (
        <div className="card divide-y divide-line">
          {list.items.map((d) => (
            <div key={d.id} className="flex flex-wrap items-start gap-3 p-4">
              <Avatar src={d.is_anonymous ? null : d.donor_avatar} name={d.is_anonymous ? 'Anonymous' : d.donor_display_name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {d.is_anonymous ? 'Anonymous' : d.donor_display_name}
                  {d.audio_file_id && <Mic className="ml-2 inline size-4 text-volt" aria-label="Includes voice note" />}
                </p>
                {d.message && <p className="text-sm text-muted">{d.message}</p>}
                <p className="text-xs text-subtle">{fmtDateTime(d.created_at)}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className="num text-lg font-semibold">{fmtMoney(d.amount_cents, d.currency)}</span>
                <Badge tone={d.status === 'COMPLETED' ? 'success' : d.status === 'PENDING' ? 'amber' : d.status === 'REFUNDED' ? 'cyan' : 'danger'}>{d.status.toLowerCase()}</Badge>
                {d.status === 'COMPLETED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RotateCcw className="size-4" />}
                    loading={refund.isPending && refund.variables?.id === d.id}
                    onClick={async () => {
                      if (await confirm({ title: `Refund ${fmtMoney(d.amount_cents, d.currency)}?`, body: 'The donor is refunded through the payment provider. This cannot be undone.', confirmLabel: 'Refund', tone: 'danger' })) refund.mutate(d);
                    }}
                  >
                    Refund
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <LoadMore q={list} />
    </div>
  );
}
