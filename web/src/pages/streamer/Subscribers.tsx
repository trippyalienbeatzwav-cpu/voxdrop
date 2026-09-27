import { useSearchParams } from 'react-router-dom';
import { Gift, Sparkles } from 'lucide-react';
import { qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtDateTime, fmtPoints } from '../../lib/format';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Tabs } from '../../components/ui/Tabs';
import { LoadMore, usePaged } from '../../components/shared';

interface Row {
  id: string;
  created_at: string;
  kind?: string;
  kick_username?: string;
  duration_months?: number;
  linked?: boolean;
  gifter_username?: string;
  is_anonymous?: boolean;
  gift_count?: number;
  reward_points: number;
  reward_status: string;
}

const STATUS: Record<string, { label: string; tone: 'success' | 'amber' | 'neutral' | 'danger' | 'cyan' }> = {
  AWARDED: { label: 'Rewarded', tone: 'success' },
  PENDING_LINK: { label: 'Waiting for sign-up', tone: 'amber' },
  CAPPED: { label: 'Daily cap reached', tone: 'cyan' },
  DISABLED: { label: 'Rewards off', tone: 'neutral' },
  NONE: { label: 'No reward', tone: 'neutral' },
};

export default function Subscribers({ defaultKind = 'subs' }: { defaultKind?: 'subs' | 'gifts' }) {
  const { channel } = useChannel();
  const sid = channel?.id;
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') as 'subs' | 'gifts' | null) ?? defaultKind;
  const list = usePaged<Row>(['channel-subs', sid, kind], (cursor) => `/api/channels/${sid}/subscriptions${qs({ kind, cursor, limit: 25 })}`, !!sid);
  return (
    <div>
      <PageHeader title="Subscribers" subtitle="Subscriptions and gifted subs received from Kick webhooks, with the points each one earned." />
      <Tabs
        label="Event type"
        value={kind}
        onChange={(v) => setParams({ kind: v }, { replace: true })}
        className="mb-4"
        tabs={[
          { value: 'subs', label: 'Subscriptions', icon: <Sparkles className="size-4" /> },
          { value: 'gifts', label: 'Gift subs', icon: <Gift className="size-4" /> },
        ]}
      />
      {list.isLoading ? (
        <SkeletonList />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <EmptyState icon={kind === 'subs' ? <Sparkles /> : <Gift />} title="No events yet" body="Kick subscription events appear here as soon as your channel’s webhooks deliver them." />
      ) : (
        <div className="card divide-y divide-line">
          {list.items.map((r) => {
            const name = kind === 'subs' ? r.kick_username! : r.is_anonymous ? 'Anonymous' : r.gifter_username!;
            const st = STATUS[r.reward_status] ?? STATUS.NONE!;
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 p-4">
                <Avatar name={name} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{name}</p>
                  <p className="text-xs text-subtle">
                    {kind === 'subs' ? `${r.kind === 'GIFTED' ? 'Received a gifted sub' : r.kind === 'RENEWAL' ? `Resubscribed · ${r.duration_months} months` : 'New subscriber'}` : `Gifted ${r.gift_count} sub${r.gift_count === 1 ? '' : 's'}`} · {fmtDateTime(r.created_at)}
                  </p>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="num w-20 text-right text-sm font-semibold text-volt">{r.reward_points ? `+${fmtPoints(r.reward_points)}` : '—'}</span>
              </div>
            );
          })}
        </div>
      )}
      <LoadMore q={list} />
    </div>
  );
}
