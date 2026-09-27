import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, CheckCircle2, Coins, Gift, HandCoins, Play, RotateCcw, Shield, XCircle } from 'lucide-react';
import { post } from '../../lib/api';
import { cx, fmtRelative } from '../../lib/format';
import type { Notification } from '../../lib/types';
import { EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
import { LoadMore, usePaged } from '../../components/shared';

const ICONS: Record<string, React.ReactNode> = {
  'message.approved': <CheckCircle2 className="size-4 text-cyan" />,
  'message.rejected': <XCircle className="size-4 text-danger" />,
  'message.played': <Play className="size-4 text-volt" />,
  'message.expired': <RotateCcw className="size-4 text-muted" />,
  'points.received': <Coins className="size-4 text-volt" />,
  'subscription.reward': <Gift className="size-4 text-magenta" />,
  'gift_sub.reward': <Gift className="size-4 text-magenta" />,
  'donation.completed': <HandCoins className="size-4 text-success" />,
  'donation.received': <HandCoins className="size-4 text-magenta" />,
  'donation.refunded': <RotateCcw className="size-4 text-cyan" />,
  refund: <RotateCcw className="size-4 text-cyan" />,
  security: <Shield className="size-4 text-amber" />,
  'moderation.warning': <Shield className="size-4 text-amber" />,
  'moderation.banned': <Shield className="size-4 text-danger" />,
};

export default function Notifications() {
  const q = usePaged<Notification>(['notifications', 'page'], (cursor) => `/api/notifications?limit=30${cursor ? `&cursor=${cursor}` : ''}`);
  const qc = useQueryClient();
  const readAll = useMutation({
    mutationFn: () => post('/api/notifications/read', { all: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        actions={
          <Button size="sm" icon={<CheckCheck className="size-4" />} onClick={() => readAll.mutate()} loading={readAll.isPending}>
            Mark all read
          </Button>
        }
      />
      {q.isLoading ? (
        <SkeletonList />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.items.length ? (
        <EmptyState icon={<Bell />} title="No notifications yet" body="Approvals, plays, rewards and donations will show up here in real time." />
      ) : (
        <ul className="card divide-y divide-line">
          {q.items.map((n) => (
            <li key={n.id} className={cx('flex gap-4 p-4', !n.read_at && 'bg-volt/[0.03]')}>
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-raised" aria-hidden>
                {ICONS[n.type] ?? <Bell className="size-4 text-muted" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {n.title}
                  {!n.read_at && <span className="sr-only"> (unread)</span>}
                </p>
                {n.body && <p className="text-sm text-muted">{n.body}</p>}
              </div>
              <time className="shrink-0 text-xs text-subtle" dateTime={n.created_at}>
                {fmtRelative(n.created_at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <LoadMore q={q} />
    </div>
  );
}
